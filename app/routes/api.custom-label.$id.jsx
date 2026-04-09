import { generateLabelHtml } from "../utils/printLabel";
import prisma from "../db.server";

const PRINT_SETTING_KEYS = [
    "label_header", "label_bnpl_line1", "label_bnpl_line2", "label_biller_id",
    "label_from_name", "label_from_address1", "label_from_address2",
    "label_from_city", "label_from_province", "label_from_zip", "label_from_phone"
];

export const loader = async ({ params }) => {
    const orderId = parseInt(params.id, 10);
    if (!orderId) return new Response("Invalid order ID", { status: 400 });

    const [order, settingsRows, parcels] = await Promise.all([
        prisma.customOrder.findUnique({ where: { id: orderId } }),
        prisma.setting.findMany({ where: { key: { in: PRINT_SETTING_KEYS } } }),
        prisma.parcel.findMany({ 
            where: { orderId: `custom-${orderId}` },
            include: { addons: { include: { addon: true } } }
        })
    ]);

    if (!order) return new Response("Order not found", { status: 404 });
    if (!parcels || parcels.length === 0) return new Response("No fulfillment parcel found for this order. Please fulfill the order first.", { status: 404 });

    const s = {};
    settingsRows.forEach(r => s[r.key] = r.value);

    const adaptedOrder = {
      name: order.orderName,
      createdAt: order.createdAt,
      totalPriceSet: { shopMoney: { amount: order.totalAmount.toString(), currencyCode: "INR" } },
      totalOutstandingSet: { shopMoney: { amount: Math.max(0, order.totalAmount - (order.partialPaymentAmount || 0)).toString(), currencyCode: "INR" } },
      customer: {
        firstName: order.customerName,
        lastName: "",
        defaultEmailAddress: { emailAddress: order.customerEmail },
        defaultPhoneNumber: { phoneNumber: order.customerPhone }
      },
      shippingAddress: {
        address1: order.address1 || "",
        address2: order.address2 || "",
        city: order.city || "",
        province: order.province || "",
        zip: order.zip || "",
        country: order.country || "India",
        phone: order.customerPhone || ""
      },
      displayFinancialStatus: order.paymentStatus,
      lineItems: { edges: JSON.parse(order.items || "[]").map(item => ({ node: {
          title: item.title,
          quantity: item.quantity,
          originalTotalSet: { shopMoney: { amount: (item.price * item.quantity).toString(), currencyCode: "INR"} }
      }})) }
    };

    const html = generateLabelHtml({ order: adaptedOrder, shop: {}, parcel: parcels[0], printSettings: s });
    return new Response(html, { headers: { "Content-Type": "text/html" } });
};
