import { json } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { getPrintSettings } from "../utils/printSettings.server";

/**
 * API route to fetch the order + shop + print-settings data needed for printing.
 * Used by pages that don't already have the full order object (e.g. parcels listing, orders listing).
 *
 * POST body: { intent: "getLabelData", orderId: "gid://shopify/Order/..." }
 */

export const action = async ({ request }) => {
    const { admin } = await authenticate.admin(request);
    const formData = await request.formData();
    const intent = formData.get("intent");

    if (intent === "getLabelData") {
        const orderId = formData.get("orderId");
        
        let orderResultData = null;
        let shopResultData = null;
        let printSettings = null;
        let parcels = [];
        let invoice = null;

        if (orderId.startsWith("custom-")) {
            const customId = parseInt(orderId.replace("custom-", ""), 10);
            
            const [localOrder, shopResponse, rawSettings, localParcels, localInvoice] = await Promise.all([
                prisma.customOrder.findUnique({ where: { id: customId } }),
                admin.graphql(`#graphql
                    query {
                        shop {
                            name
                            billingAddress {
                                address1 address2 city province zip country phone
                            }
                        }
                    }
                `),
                getPrintSettings(),
                prisma.parcel.findMany({
                    where: { orderId: orderId },
                    include: { addons: { include: { addon: true } } }
                }),
                prisma.invoice.findUnique({
                    where: { orderId: orderId }
                })
            ]);
            
            shopResultData = (await shopResponse.json())?.data?.shop;
            printSettings = rawSettings;
            parcels = localParcels;
            invoice = localInvoice;

            if (localOrder) {
                const parts = (localOrder.customerName || "").split(" ");
                const firstName = parts[0] || "";
                const lastName = parts.slice(1).join(" ") || "";
                
                const items = localOrder.items ? JSON.parse(localOrder.items) : [];
                
                orderResultData = {
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
        } else {
            const orderGid = orderId.startsWith("gid://") ? orderId : `gid://shopify/Order/${orderId}`;
            const [orderResponse, shopResponse, rawSettings, localParcels, localInvoice] = await Promise.all([
                admin.graphql(
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
                ),
                admin.graphql(`#graphql
                    query {
                        shop {
                            name
                            billingAddress {
                                address1 address2 city province zip country phone
                            }
                        }
                    }
                `),
                getPrintSettings(),
                prisma.parcel.findMany({
                    where: { orderId: orderGid },
                    include: { addons: { include: { addon: true } } }
                }),
                prisma.invoice.findUnique({
                    where: { orderId: orderGid }
                })
            ]);

            const orderResult = await orderResponse.json();
            const shopResult = await shopResponse.json();
            orderResultData = orderResult.data?.order;
            shopResultData = shopResult.data?.shop;
            printSettings = rawSettings;
            parcels = localParcels;
            invoice = localInvoice;
        }

        return json({
            intent: "getLabelData",
            order: orderResultData,
            shop: shopResultData,
            printSettings,
            parcels,
            invoice,
        });
    }

    return json({ error: "Unknown intent" }, { status: 400 });
};
