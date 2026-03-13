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
      // Step 1: Complete Draft Order as PENDING/UNPAID (correct for deposit flow)
      const completeResp = await admin.graphql(
        `#graphql
        mutation draftOrderComplete($id: ID!, $paymentPending: Boolean!) {
          draftOrderComplete(id: $id, paymentPending: $paymentPending) {
            draftOrder {
              order {
                id
                name
                displayFinancialStatus
              }
            }
            userErrors { field message }
          }
        }`,
        {
          variables: {
            id: draftOrderGid,
            paymentPending: true,
          },
        }
      );

      const completeData = await completeResp.json();

      if (completeData.data?.draftOrderComplete?.userErrors?.length > 0) {
        console.error(
          "[razorpay-webhook] Failed to complete draft order:",
          JSON.stringify(completeData.data.draftOrderComplete.userErrors)
        );
        return new Response("OK", { status: 200 });
      }

      const newOrder =
        completeData.data?.draftOrderComplete?.draftOrder?.order;

      if (!newOrder) {
        console.error(
          "[razorpay-webhook] Draft order completion returned no order."
        );
        return new Response("OK", { status: 200 });
      }

      const orderIdGql = newOrder.id;
      const orderName = newOrder.name;

      // Step 2: Extract paid amount from Razorpay payload (partial deposit)
      const amountPaidInPaise = paymentLinkEntity?.amount_paid || 0;
      const amountPaid = (amountPaidInPaise / 100).toFixed(2); // "200.00"
      const currencyCode = paymentLinkEntity?.currency || "INR";

      console.log(
        `[razorpay-webhook] Razorpay paid amount: ${amountPaid} ${currencyCode} for order ${orderName}`
      );

      if (Number(amountPaid) > 0) {
        // Step 3: Record this partial amount as a metafield on the order
        // Namespace: "payments", Key: "advance_paid"
        const metafieldResp = await admin.graphql(
          `#graphql
          mutation SetOrderAdvancePaidMetafield($metafields: [MetafieldsSetInput!]!) {
            metafieldsSet(metafields: $metafields) {
              metafields {
                id
                namespace
                key
                value
              }
              userErrors {
                field
                message
              }
            }
          }`,
          {
            variables: {
              metafields: [
                {
                  ownerId: orderIdGql,
                  namespace: "payments",
                  key: "advance_paid",
                  type: "number_decimal",
                  value: amountPaid.toString(),
                },
              ],
            },
          }
        );

        const metaData = await metafieldResp.json();

        if (metaData.data?.metafieldsSet?.userErrors?.length > 0) {
          console.error(
            "[razorpay-webhook] Failed to set advance_paid metafield:",
            JSON.stringify(metaData.data.metafieldsSet.userErrors)
          );
        } else if (metaData.errors) {
          console.error(
            "[razorpay-webhook] GraphQL error in metafieldsSet:",
            JSON.stringify(metaData.errors)
          );
        } else {
          console.log(
            `[razorpay-webhook] Recorded advance payment of ${amountPaid} ${currencyCode} on order ${orderName} via metafield payments.advance_paid`
          );
        }
      }

      console.log(
        orderName
          ? `[razorpay-webhook] Payment confirmed. Draft order ${referenceId} → Shopify Order ${orderName} (Advance paid: ${amountPaid})`
          : `[razorpay-webhook] Payment confirmed. Draft order ${referenceId} completed.`
      );
    } catch (error) {
      console.error("[razorpay-webhook] Admin API error:", error);
      return new Response("OK", { status: 200 });
    }
  }

  return new Response("OK", { status: 200 });
};
