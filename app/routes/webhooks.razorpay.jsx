import crypto from "crypto";
import prisma from "../db.server";
import { unauthenticated } from "../shopify.server";

// Public route — no Shopify auth. Razorpay POSTs here after payment.
export const action = async ({ request }) => {
  if (request.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  // Read raw body BEFORE parsing — required for correct signature verification
  const rawBody = await request.text();
  const signature = request.headers.get("x-razorpay-signature");

  if (!signature) {
    return new Response("Missing signature", { status: 400 });
  }

  // Fetch webhook secret from DB
  const secretRow = await prisma.setting.findUnique({
    where: { key: "razorpay_webhook_secret" },
  });

  if (!secretRow?.value) {
    console.error("[razorpay-webhook] Webhook secret not configured.");
    // Return 200 so Razorpay doesn't keep retrying for a config issue
    return new Response("OK", { status: 200 });
  }

  // Verify HMAC-SHA256 signature
  const expected = crypto
    .createHmac("sha256", secretRow.value)
    .update(rawBody)
    .digest("hex");

  const sigBuffer = Buffer.from(signature, "hex");
  const expBuffer = Buffer.from(expected, "hex");

  if (
    sigBuffer.length !== expBuffer.length ||
    !crypto.timingSafeEqual(sigBuffer, expBuffer)
  ) {
    console.warn("[razorpay-webhook] Invalid signature — ignoring.");
    return new Response("Invalid signature", { status: 401 });
  }

  const body = JSON.parse(rawBody);
  const event = body.event;

  console.log(`[razorpay-webhook] Received event: ${event}`);

  // Only act on payment_link.paid
  if (event === "payment_link.paid") {
    const paymentLinkEntity = body.payload?.payment_link?.entity;
    const referenceId = paymentLinkEntity?.reference_id; // numeric draft order ID

    if (!referenceId) {
      console.warn("[razorpay-webhook] payment_link.paid has no reference_id.");
      return new Response("OK", { status: 200 });
    }

    const draftOrderGid = `gid://shopify/DraftOrder/${referenceId}`;

    const session = await prisma.session.findFirst({
      where: { isOnline: false },
      orderBy: { id: "desc" },
    });

    if (!session) {
      console.error("[razorpay-webhook] No offline session found. Cannot complete draft order.");
      return new Response("OK", { status: 200 });
    }

    const { shop } = session;
    const { admin } = await unauthenticated.admin(shop);

    try {
      // Step 1: Query Draft Order details
      const draftQuery = await admin.graphql(`
        query getDraftOrder($id: ID!) {
          draftOrder(id: $id) {
            name email phone tags
            customAttributes { key value }
            customer { id }
            billingAddress {
              firstName lastName address1 address2 city provinceCode countryCodeV2 zip phone company
            }
            shippingAddress {
              firstName lastName address1 address2 city provinceCode countryCodeV2 zip phone company
            }
            shippingLine {
              title price
            }
            lineItems(first: 50) {
              edges {
                node {
                  variant { id }
                  quantity originalUnitPrice title requiresShipping sku taxable
                }
              }
            }
          }
        }
      `, { variables: { id: draftOrderGid } });

      const draftJson = await draftQuery.json();
      const draftData = draftJson.data?.draftOrder;

      if (!draftData) {
        console.error("[razorpay-webhook] Draft order not found.");
        return new Response("OK", { status: 200 });
      }

      const mapAddress = (addr) => addr ? {
        first_name: addr.firstName, last_name: addr.lastName,
        address1: addr.address1, address2: addr.address2,
        city: addr.city, province_code: addr.provinceCode,
        country_code: addr.countryCodeV2, zip: addr.zip,
        phone: addr.phone, company: addr.company
      } : undefined;

      const orderPayload = {
        order: {
          email: draftData.email,
          phone: draftData.phone,
          tags: draftData.tags ? draftData.tags.join(',') : "",
          note_attributes: draftData.customAttributes?.map(attr => ({ name: attr.key, value: attr.value })),
          financial_status: "pending",
          customer: draftData.customer ? { id: parseInt(draftData.customer.id.split('/').pop(), 10) } : undefined,
          billing_address: mapAddress(draftData.billingAddress),
          shipping_address: mapAddress(draftData.shippingAddress),
          line_items: draftData.lineItems?.edges?.map(e => ({
            variant_id: e.node.variant?.id ? parseInt(e.node.variant.id.split('/').pop(), 10) : undefined,
            quantity: e.node.quantity,
            price: e.node.originalUnitPrice,
            title: e.node.title,
            requires_shipping: e.node.requiresShipping,
            sku: e.node.sku,
            taxable: e.node.taxable
          }))
        }
      };

      if (draftData.shippingLine) {
        orderPayload.order.shipping_lines = [{
          title: draftData.shippingLine.title,
          price: draftData.shippingLine.price,
        }];
      }

      // Step 2: Create unpaid order via REST
      const createOrderResp = await fetch(`https://${shop}/admin/api/2025-01/orders.json`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Shopify-Access-Token": session.accessToken,
        },
        body: JSON.stringify(orderPayload)
      });

      const createdOrderData = await createOrderResp.json();

      if (!createOrderResp.ok || createdOrderData.errors) {
        console.error("[razorpay-webhook] Failed to create unpaid order from draft.", JSON.stringify(createdOrderData.errors));
        return new Response("OK", { status: 200 });
      }

      const newOrder = createdOrderData.order;
      const orderIdGql = `gid://shopify/Order/${newOrder.id}`;
      const orderName = newOrder.name;

      // Delete the old draft order
      await admin.graphql(`
        mutation draftOrderDelete($input: DraftOrderDeleteInput!) {
          draftOrderDelete(input: $input) { deletedId }
        }
      `, { variables: { input: { id: draftOrderGid } } });

      // Step 3: Extract paid amount from Razorpay payload
      const amountPaidInPaise = paymentLinkEntity?.amount_paid || 0;
      const amountPaid = (amountPaidInPaise / 100).toFixed(2);
      const currencyCode = paymentLinkEntity?.currency || "INR";

      if (amountPaid > 0) {
        // Step 4: Create a transaction on the order using orderCreateManualPayment
        const manualPaymentResp = await admin.graphql(
          `#graphql
          mutation orderCreateManualPayment($id: ID!, $amount: MoneyInput, $paymentMethodName: String) {
            orderCreateManualPayment(id: $id, amount: $amount, paymentMethodName: $paymentMethodName) {
              order { id name displayFinancialStatus }
              userErrors { field message }
            }
          }`,
          {
            variables: {
              id: orderIdGql,
              amount: {
                amount: amountPaid.toString(),
                currencyCode: currencyCode
              },
              paymentMethodName: "Razorpay"
            }
          }
        );

        const txData = await manualPaymentResp.json();

        if (txData.data?.orderCreateManualPayment?.userErrors?.length > 0) {
          console.error("[razorpay-webhook] Failed to create manual payment.", JSON.stringify(txData.data.orderCreateManualPayment.userErrors));
        } else if (txData.errors) {
          console.error("[razorpay-webhook] GraphQL error while creating manual payment:", JSON.stringify(txData.errors));
        } else {
          const newStatus = txData.data?.orderCreateManualPayment?.order?.displayFinancialStatus;
          console.log(`[razorpay-webhook] Recorded payment of ${amountPaid} INR for Order ${orderName}. New status: ${newStatus}`);
        }
      }

      console.log(
        orderName
          ? `[razorpay-webhook] Payment confirmed. Draft order ${referenceId} → Shopify Order ${orderName} (Paid: ${amountPaid})`
          : `[razorpay-webhook] Payment confirmed. Draft order ${referenceId} completed.`
      );
    } catch (error) {
      console.error("[razorpay-webhook] Admin API error:", error);
      return new Response("OK", { status: 200 });
    }
  }

  return new Response("OK", { status: 200 });
};
