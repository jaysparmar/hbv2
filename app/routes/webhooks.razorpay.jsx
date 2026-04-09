import crypto from "crypto";
import prisma from "../db.server";

// Handle GET requests (e.g. browser ping or uptime checks)
export const loader = async () => {
  return new Response("Razorpay webhook endpoint is active and listening for POST requests.", { status: 200 });
};

// Public route — no Shopify auth. Razorpay POSTs here after payment.
export const action = async ({ request }) => {
  console.log("[razorpay-webhook] Received request");
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
    return new Response("OK", { status: 200 }); // Return 200 so Razorpay doesn't keep retrying
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
    const rawReferenceId = paymentLinkEntity?.reference_id || "";
    // We parse reference_id because we append _TIMESTAMP to make it unique per link
    const orderName = rawReferenceId.split('_')[0];

    if (!orderName) {
      console.warn("[razorpay-webhook] payment_link.paid has no reference_id (orderName).");
      return new Response("OK", { status: 200 });
    }

    const order = await prisma.customOrder.findUnique({
      where: { orderName: orderName }
    });

    if (!order) {
      console.error(`[razorpay-webhook] CustomOrder with orderName ${orderName} not found.`);
      return new Response("OK", { status: 200 });
    }

    try {
      const amountPaidInPaise = paymentLinkEntity?.amount_paid || 0;
      const amountPaid = amountPaidInPaise / 100;
      const currencyCode = paymentLinkEntity?.currency || "INR";
      const paymentLinkId = paymentLinkEntity?.id;
      // Get the payment ID from the order array if available
      const paymentId = body.payload?.order?.entity?.payments?.[0]?.id || "unknown";

      console.log(`[razorpay-webhook] Razorpay paid amount: ${amountPaid} ${currencyCode} for custom order ${orderName}`);

      if (amountPaid > 0) {
        // 1. Resolve pending transaction or record locally
        const existingTx = paymentLinkId ? await prisma.transactionHistory.findFirst({
          where: { paymentLinkId: paymentLinkId }
        }) : null;

        if (existingTx && existingTx.status === "PENDING") {
          await prisma.transactionHistory.update({
            where: { id: existingTx.id },
            data: { status: "SUCCESS", paymentId: paymentId }
          });
        } else if (!existingTx) {
          // Fallback if link wasn't recorded or generated via older app version
          await prisma.transactionHistory.create({
            data: {
              orderName: orderName,
              amountPaid: amountPaid,
              currency: currencyCode,
              paymentLinkId: paymentLinkId,
              paymentId: paymentId,
              status: "SUCCESS",
              mode: "Razorpay"
            }
          });
        } else {
          // Already SUCCESS or handled
          console.log(`[razorpay-webhook] Payment link ${paymentLinkId} already processed. Ignoring.`);
          return new Response("OK", { status: 200 });
        }

        // 2. Compute new payment totals and status
        const currentPartial = parseFloat(order.partialPaymentAmount || 0);
        const newPartial = currentPartial + amountPaid;
        const totalAmount = parseFloat(order.totalAmount || 0);

        // Standard floating point comparison epsilon tolerance
        let newStatus = "PARTIALLY PAID";
        if (newPartial >= totalAmount || totalAmount === 0 || Math.abs(newPartial - totalAmount) < 0.01) {
          newStatus = "FULLY PAID";
        }

        // 3. Update CustomOrder automatically
        await prisma.customOrder.update({
          where: { id: order.id },
          data: {
            partialPaymentAmount: newPartial,
            paymentStatus: newStatus
          }
        });

        console.log(`[razorpay-webhook] Payment confirmed. CustomOrder ${orderName} automatically updated to ${newStatus} (Total Paid: ${newPartial})`);
      }
    } catch (error) {
      console.error("[razorpay-webhook] Processing error:", error);
      return new Response("OK", { status: 200 });
    }
  }

  return new Response("OK", { status: 200 });
};
