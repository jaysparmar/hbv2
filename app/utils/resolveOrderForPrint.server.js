import prisma from "../db.server";

/**
 * Resolves a Parcel's `orderId` (either a Shopify order GID, or a local
 * `custom-<id>` order) into the order-shaped object expected by
 * generateLabelHtml/generateInvoiceHtml (and the pdfmake label renderer).
 *
 * Returns null if the order can't be found.
 */
export async function resolveOrderForPrint({ orderId, admin }) {
    if (orderId.startsWith("custom-")) {
        const customId = parseInt(orderId.replace("custom-", ""), 10);
        const localOrder = await prisma.customOrder.findUnique({ where: { id: customId } });
        if (!localOrder) return null;

        const parts = (localOrder.customerName || "").split(" ");
        const firstName = parts[0] || "";
        const lastName = parts.slice(1).join(" ") || "";
        const items = localOrder.items ? JSON.parse(localOrder.items) : [];

        return {
            id: `custom-${localOrder.id}`,
            name: localOrder.orderName,
            createdAt: localOrder.createdAt,
            displayFinancialStatus: localOrder.paymentStatus === "FULLY PAID" ? "PAID" : (localOrder.paymentStatus === "PARTIALLY PAID" ? "PARTIALLY_PAID" : "PENDING"),
            customer: {
                firstName, lastName,
                defaultEmailAddress: localOrder.customerEmail ? { emailAddress: localOrder.customerEmail } : null,
                defaultPhoneNumber: localOrder.customerPhone ? { phoneNumber: localOrder.customerPhone } : null
            },
            shippingAddress: {
                address1: localOrder.address1,
                address2: localOrder.address2,
                city: localOrder.city,
                province: localOrder.province,
                zip: localOrder.zip,
                country: localOrder.country,
                phone: localOrder.phone
            },
            lineItems: {
                edges: items.map(item => ({
                    node: {
                        title: item.title,
                        quantity: item.quantity,
                        originalTotalSet: { shopMoney: { amount: (item.price * item.quantity).toFixed(2), currencyCode: "INR" } }
                    }
                }))
            },
            totalPriceSet: { shopMoney: { amount: localOrder.totalAmount.toFixed(2), currencyCode: "INR" } },
            totalOutstandingSet: { shopMoney: { amount: localOrder.paymentStatus === "FULLY PAID" ? "0.00" : Math.max(0, localOrder.totalAmount - (localOrder.partialPaymentAmount || 0)).toFixed(2), currencyCode: "INR" } }
        };
    }

    const orderGid = orderId.startsWith("gid://") ? orderId : `gid://shopify/Order/${orderId}`;
    const orderResponse = await admin.graphql(
        `#graphql
        query getOrderForLabel($id: ID!) {
            order(id: $id) {
                id
                name
                createdAt
                displayFinancialStatus
                customer {
                    firstName lastName
                    defaultEmailAddress { emailAddress }
                    defaultPhoneNumber { phoneNumber }
                }
                shippingAddress {
                    address1 address2 city province zip country phone
                }
                lineItems(first: 50) {
                    edges {
                        node {
                            title
                            quantity
                            originalTotalSet { shopMoney { amount currencyCode } }
                        }
                    }
                }
                totalPriceSet { shopMoney { amount currencyCode } }
                totalOutstandingSet { shopMoney { amount currencyCode } }
            }
        }`,
        { variables: { id: orderGid } }
    );

    const orderResult = await orderResponse.json();
    return orderResult.data?.order || null;
}
