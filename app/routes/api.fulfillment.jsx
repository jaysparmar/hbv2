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
        return json({ intent: "fetchOrderData", orderData: result.data?.order });
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
            createdParcel = await prisma.parcel.create({
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
        }

        return json({ intent: "fulfill", success: true, parcel: createdParcel });
    }

    return json({ error: "Unknown intent" }, { status: 400 });
};
