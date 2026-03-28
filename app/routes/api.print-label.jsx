import { json } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";

/**
 * API route to fetch the order + shop + print-settings data needed for printing.
 * Used by pages that don't already have the full order object (e.g. parcels listing, orders listing).
 *
 * POST body: { intent: "getLabelData", orderId: "gid://shopify/Order/..." }
 */

const PRINT_SETTING_KEYS = [
    "label_header", "label_bnpl_line1", "label_bnpl_line2", "label_biller_id",
    "label_from_name", "label_from_address1", "label_from_address2",
    "label_from_city", "label_from_province", "label_from_zip", "label_from_phone",
    "invoice_company_name", "invoice_title", "invoice_gstin",
    "invoice_footer", "invoice_terms",
    "invoice_from_address1", "invoice_from_address2",
    "invoice_from_city", "invoice_from_province", "invoice_from_zip",
    "invoice_from_phone", "invoice_from_email",
];

async function getPrintSettings() {
    const rows = await prisma.setting.findMany({
        where: { key: { in: PRINT_SETTING_KEYS } },
    });
    const map = {};
    rows.forEach(r => { map[r.key] = r.value; });
    return map;
}

export const action = async ({ request }) => {
    const { admin } = await authenticate.admin(request);
    const formData = await request.formData();
    const intent = formData.get("intent");

    if (intent === "getLabelData") {
        const orderId = formData.get("orderId");
        const orderGid = orderId.startsWith("gid://") ? orderId : `gid://shopify/Order/${orderId}`;

        const [orderResponse, shopResponse, printSettings] = await Promise.all([
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
        ]);

        const orderResult = await orderResponse.json();
        const shopResult = await shopResponse.json();

        return json({
            intent: "getLabelData",
            order: orderResult.data?.order,
            shop: shopResult.data?.shop,
            printSettings,
        });
    }

    return json({ error: "Unknown intent" }, { status: 400 });
};
