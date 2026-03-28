import { json } from "@remix-run/node";
import { authenticate } from "../shopify.server";

/**
 * API route to fetch the order + shop data needed for printing a label.
 * Used by pages that don't already have the full order object (e.g. parcels listing).
 *
 * POST body: { intent: "getLabelData", orderId: "gid://shopify/Order/..." }
 */
export const action = async ({ request }) => {
    const { admin } = await authenticate.admin(request);
    const formData = await request.formData();
    const intent = formData.get("intent");

    if (intent === "getLabelData") {
        const orderId = formData.get("orderId");
        const orderGid = orderId.startsWith("gid://") ? orderId : `gid://shopify/Order/${orderId}`;

        const [orderResponse, shopResponse] = await Promise.all([
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
        ]);

        const orderResult = await orderResponse.json();
        const shopResult = await shopResponse.json();

        return json({
            intent: "getLabelData",
            order: orderResult.data?.order,
            shop: shopResult.data?.shop,
        });
    }

    return json({ error: "Unknown intent" }, { status: 400 });
};
