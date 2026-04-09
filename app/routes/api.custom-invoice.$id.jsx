import { generateInvoiceHtml } from "../utils/printInvoice";
import prisma from "../db.server";

const PRINT_SETTING_KEYS = [
    "invoice_company_name", "invoice_title", "invoice_gstin",
    "invoice_footer", "invoice_terms",
    "invoice_from_address1", "invoice_from_address2",
    "invoice_from_city", "invoice_from_province", "invoice_from_zip",
    "invoice_from_phone", "invoice_from_email", "invoice_signature",
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

    const html = generateInvoiceHtml({ order: adaptedOrder, shop: {}, printSettings: s, parcels });
    return new Response(html, { headers: { "Content-Type": "text/html" } });
};
