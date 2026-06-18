import { json } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";

export const action = async ({ request }) => {
    const { admin } = await authenticate.admin(request);
    const formData = await request.formData();
    const intent = formData.get("intent");

    if (intent === "fetchOrderData") {
        const orderId = formData.get("orderId");
        const orderGid = orderId.startsWith("gid://") ? orderId : `gid://shopify/Order/${orderId}`;
        const response = await admin.graphql(
            `#graphql
            query getOrderFulfillments($id: ID!) {
                order(id: $id) {
                    id
                    name
                    shippingAddress {
                        address1 address2 city province zip country phone
                    }
                    totalPriceSet {
                        shopMoney {
                            amount
                            currencyCode
                        }
                    }
                    totalOutstandingSet {
                        shopMoney {
                            amount
                            currencyCode
                        }
                    }
                    fulfillmentOrders(first: 10) {
                        edges {
                            node {
                                id
                                status
                                supportedActions { action }
                                lineItems(first: 50) {
                                    edges {
                                        node {
                                            id
                                            totalQuantity
                                            remainingQuantity
                                            lineItem { title }
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }`,
            { variables: { id: orderGid } }
        );
        const result = await response.json();

        // Calculate remaining COD
        const orderData = result.data?.order;
        let remainingCOD = 0;
        let totalOutstanding = 0;
        let totalCODCollected = 0;

        if (orderData) {
            totalOutstanding = parseFloat(orderData.totalOutstandingSet?.shopMoney?.amount || 0);

            const parcels = await prisma.parcel.findMany({
                where: { orderId: orderGid }
            });
            totalCODCollected = parcels.reduce((sum, p) => {
                const val = parseFloat(p.valueOfRepayment);
                return sum + (isNaN(val) ? 0 : val);
            }, 0);

            remainingCOD = Math.max(0, totalOutstanding - totalCODCollected);
        }

        return json({
            intent: "fetchOrderData",
            orderData,
            totalOutstanding,
            totalCODCollected,
            remainingCOD
        });
    }

    if (intent === "fulfill") {
        const fulfillmentOrderId = formData.get("fulfillmentOrderId");
        const orderName = formData.get("orderName") || "";
        const orderId = formData.get("orderId") || "";

        const lineItems = [];
        for (const [key, value] of formData.entries()) {
            if (key.startsWith("qty_") && value) {
                const quantity = parseInt(value, 10);
                if (quantity > 0) {
                    lineItems.push({ id: key.replace("qty_", ""), quantity });
                }
            }
        }

        const awbNumber = formData.get("awbNumber");
        const carrierIdStr = formData.get("carrierId");
        const carrierName = formData.get("carrierName");
        const parcelLength = parseFloat(formData.get("parcelLength")) || 0;
        const parcelWidth = parseFloat(formData.get("parcelWidth")) || 0;
        const parcelHeight = parseFloat(formData.get("parcelHeight")) || 0;
        const parcelWeight = parseFloat(formData.get("parcelWeight")) || 0;
        const parcelValueOfRepayment = formData.get("parcelValueOfRepayment")?.toString() || null;

        const addonPayloadRaw = formData.get("addonPayload");
        const selectedAddons = addonPayloadRaw ? JSON.parse(addonPayloadRaw) : [];

        if (selectedAddons.length > 0) {
            const addonIds = selectedAddons.map(a => parseInt(a.id, 10));
            const addons = await prisma.addonProduct.findMany({
                where: { id: { in: addonIds } }
            });
            for (const item of selectedAddons) {
                const dbAddon = addons.find(a => a.id === parseInt(item.id, 10));
                if (!dbAddon || !dbAddon.isActive || dbAddon.stock < item.quantity) {
                    return json({ intent: "fulfill", errors: [{ message: `Add-on ${dbAddon?.name || item.id} is out of stock or inactive.` }] });
                }
            }
        }

        let trackingUrl = formData.get("trackingUrl") || "";
        if (trackingUrl && awbNumber) {
            trackingUrl = trackingUrl.replace("{awb_number}", awbNumber);
        }

        const fulfillmentPayload = {
            lineItemsByFulfillmentOrder: [{
                fulfillmentOrderId,
                ...(lineItems.length > 0 ? { fulfillmentOrderLineItems: lineItems } : {}),
            }],
            notifyCustomer: true,
        };

        if (awbNumber) {
            fulfillmentPayload.trackingInfo = {
                number: awbNumber,
                company: carrierName,
                url: trackingUrl,
            };
        }

        const response = await admin.graphql(
            `#graphql
            mutation fulfillmentCreateV2($fulfillment: FulfillmentV2Input!) {
                fulfillmentCreateV2(fulfillment: $fulfillment) {
                    fulfillment { id status }
                    userErrors { field message }
                }
            }`,
            { variables: { fulfillment: fulfillmentPayload } }
        );
        const result = await response.json();

        if (result.data?.fulfillmentCreateV2?.userErrors?.length > 0) {
            return json({ intent: "fulfill", errors: result.data.fulfillmentCreateV2.userErrors });
        }

        const newFulfillmentId = result.data?.fulfillmentCreateV2?.fulfillment?.id;
        let createdParcel = null;
        if (newFulfillmentId) {
            try {
                createdParcel = await prisma.$transaction(async (tx) => {
                    let invoice = await tx.invoice.findUnique({
                        where: { orderId }
                    });

                    if (!invoice) {
                        const prefixSetting = await tx.setting.findUnique({ where: { key: "invoice_prefix" } });
                        const serialSetting = await tx.setting.findUnique({ where: { key: "invoice_start_serial" } });

                        const prefix = prefixSetting?.value !== undefined ? prefixSetting.value : "INV-";
                        const serialStr = serialSetting?.value !== undefined ? serialSetting.value : "1000";
                        const serialNum = parseInt(serialStr, 10) || 1000;

                        const invoiceNumber = `${prefix}${serialNum}`;

                        invoice = await tx.invoice.create({
                            data: {
                                orderId,
                                invoiceNumber
                            }
                        });

                        await tx.setting.upsert({
                            where: { key: "invoice_start_serial" },
                            update: { value: (serialNum + 1).toString() },
                            create: { key: "invoice_start_serial", value: (serialNum + 1).toString() }
                        });
                    }

                    const parcel = await tx.parcel.create({
                        data: {
                            orderId,
                            orderName,
                            fulfillmentId: newFulfillmentId,
                            carrierId: carrierIdStr ? parseInt(carrierIdStr, 10) : null,
                            carrierName: carrierName || "Custom",
                            awbNumber: awbNumber || "",
                            length: parcelLength,
                            width: parcelWidth,
                            height: parcelHeight,
                            weight: parcelWeight,
                            valueOfRepayment: parcelValueOfRepayment,
                            dispatchStatus: "pending",
                        },
                    });

                    if (selectedAddons.length > 0) {
                        for (const item of selectedAddons) {
                            const addonIdInt = parseInt(item.id, 10);
                            const updated = await tx.addonProduct.update({
                                where: { id: addonIdInt },
                                data: { stock: { decrement: item.quantity } },
                                select: { stock: true, name: true }
                            });
                            if (updated.stock < 0) {
                                throw new Error(`Add-on ${updated.name} ran out of stock during transaction.`);
                            }
                            await tx.parcelAddon.create({
                                data: {
                                    parcelId: parcel.id,
                                    addonId: addonIdInt,
                                    quantity: item.quantity,
                                }
                            });
                        }
                    }

                    return parcel;
                });
            } catch (error) {
                // Return a user-friendly error if stock drops mid-transaction
                return json({ intent: "fulfill", errors: [{ message: error.message }] });
            }
        }

        return json({ intent: "fulfill", success: true, parcel: createdParcel });
    }

    return json({ error: "Unknown intent" }, { status: 400 });
};
