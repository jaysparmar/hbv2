import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import * as xlsx from "xlsx";

const dateRegex = /^\d{4}-\d{2}-\d{2}$/;

function formatDDMMYYYY(date) {
    if (!date) return "";
    const d = new Date(date);
    if (isNaN(d.getTime())) return "";
    const dd = String(d.getDate()).padStart(2, "0");
    const mm = String(d.getMonth() + 1).padStart(2, "0");
    const yyyy = d.getFullYear();
    return `${dd}-${mm}-${yyyy}`;
}

async function fetchAllShopifyVariants(admin) {
    let variants = [];
    let hasNext = true;
    let cursor = null;

    while (hasNext) {
        try {
            const response = await admin.graphql(
                `#graphql
                query getProductsForReport($cursor: String) {
                    products(first: 250, after: $cursor) {
                        edges {
                            node {
                                title
                                variants(first: 100) {
                                    edges {
                                        node {
                                            title
                                            displayName
                                        }
                                    }
                                }
                            }
                        }
                        pageInfo {
                            hasNextPage
                            endCursor
                        }
                    }
                }`,
                { variables: { cursor } }
            );
            const resJson = await response.json();
            const fetchedProducts = resJson.data?.products?.edges || [];
            
            for (const prodEdge of fetchedProducts) {
                const prod = prodEdge.node;
                const prodVariants = prod.variants?.edges || [];
                for (const varEdge of prodVariants) {
                    const v = varEdge.node;
                    const name = v.title === "Default Title" ? prod.title : `${prod.title} ${v.title}`;
                    variants.push({
                        name: name.trim(),
                        displayName: v.displayName || name
                    });
                }
            }

            const pageInfo = resJson.data?.products?.pageInfo;
            hasNext = pageInfo?.hasNextPage || false;
            cursor = pageInfo?.endCursor || null;

            if (fetchedProducts.length === 0) break;
        } catch (err) {
            console.error("Error fetching Shopify variants:", err);
            break;
        }
    }

    return variants;
}

async function fetchAllShopifyOrders(admin, queryStr) {
    let orders = [];
    let hasNext = true;
    let cursor = null;

    while (hasNext) {
        try {
            const response = await admin.graphql(
                `#graphql
                query getOrdersForReport($query: String!, $cursor: String) {
                    orders(first: 250, query: $query, after: $cursor) {
                        edges {
                            node {
                                name
                                createdAt
                                lineItems(first: 100) {
                                    edges {
                                        node {
                                            title
                                            variantTitle
                                            quantity
                                        }
                                    }
                                }
                            }
                        }
                        pageInfo {
                            hasNextPage
                            endCursor
                        }
                    }
                }`,
                { variables: { query: queryStr, cursor } }
            );
            const resJson = await response.json();
            const fetched = resJson.data?.orders?.edges || [];
            orders.push(...fetched.map(e => e.node));

            const pageInfo = resJson.data?.orders?.pageInfo;
            hasNext = pageInfo?.hasNextPage || false;
            cursor = pageInfo?.endCursor || null;

            if (fetched.length === 0) break;
        } catch (err) {
            console.error("Error fetching Shopify orders:", err);
            break;
        }
    }

    return orders;
}

export const loader = async ({ request }) => {
    const { admin } = await authenticate.admin(request);
    const url = new URL(request.url);
    const startDate = url.searchParams.get("startDate");
    const endDate = url.searchParams.get("endDate");
    const reportType = url.searchParams.get("reportType") || "sales";

    // Validate inputs
    if (!startDate || !endDate || !dateRegex.test(startDate) || !dateRegex.test(endDate)) {
        return new Response("Invalid date format or parameters. Please use YYYY-MM-DD.", { status: 400 });
    }

    // --- PENDING PAYMENT REPORT ---
    if (reportType === "payments") {
        const deliveries = await prisma.delivery.findMany({
            where: {
                createdAt: {
                    gte: new Date(`${startDate}T00:00:00Z`),
                    lte: new Date(`${endDate}T23:59:59Z`),
                }
            },
            orderBy: {
                createdAt: "desc"
            }
        });

        const aoa = [
            [
                "Vch. No.",
                "Date",
                "Order No.",
                "Customer",
                "Mob. No.",
                "City",
                "Pin Code No.",
                "State",
                "Order Date",
                "Pickup Date",
                "Payment Date",
                "Tracking No.",
                "Days",
                "Delivery Date",
                "Return Date",
                "Courier Charges",
                "Order Source",
                "Is Completed?",
                "Remaining Amount"
            ]
        ];

        deliveries.forEach(row => {
            let city = "";
            let state = "";
            if (row.officeName) {
                const parts = row.officeName.split(", ");
                if (parts.length >= 2) {
                    city = parts[0];
                    state = parts.slice(1).join(", ");
                } else {
                    city = row.officeName;
                }
            }

            let days = "";
            if (row.createdAt && row.deliveredDate) {
                const diffTime = Math.abs(new Date(row.deliveredDate) - new Date(row.createdAt));
                days = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
            }

            const remainingAmount = row.billDate ? 0 : row.codValue;

            aoa.push([
                row.codInvoiceNumber || row.id.toString(),
                formatDDMMYYYY(row.createdAt),
                row.contractId || "",
                row.customerName || "",
                row.customerId || "",
                city,
                row.officeId || "",
                state,
                formatDDMMYYYY(row.createdAt),
                formatDDMMYYYY(row.createdAt),
                formatDDMMYYYY(row.billDate),
                row.articleNumber || "",
                days,
                formatDDMMYYYY(row.deliveredDate),
                "", // Return Date
                row.codCommission || 0,
                row.contractMode || "",
                row.billDate ? "Yes" : "",
                remainingAmount
            ]);
        });

        const totalRemaining = deliveries.reduce((sum, r) => sum + (r.billDate ? 0 : r.codValue), 0);
        aoa.push(["TOTAL PENDING", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", totalRemaining]);

        const worksheet = xlsx.utils.aoa_to_sheet(aoa);
        const workbook = xlsx.utils.book_new();
        xlsx.utils.book_append_sheet(workbook, worksheet, "Sheet1");

        const buffer = xlsx.write(workbook, { type: "buffer", bookType: "xlsx" });

        return new Response(buffer, {
            status: 200,
            headers: {
                "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                "Content-Disposition": `attachment; filename="PENDING_PAYMENT_REPORT_${startDate}_TO_${endDate}.xlsx"`,
            },
        });
    }

    // --- SALES REPORT ---
    const allVariants = await fetchAllShopifyVariants(admin);

    const salesMap = {};
    for (const v of allVariants) {
        const name = v.displayName.replace(" - ", " ").trim();
        salesMap[name] = 0;
    }

    const queryStr = `created_at:>=${startDate}T00:00:00Z AND created_at:<=${endDate}T23:59:59Z`;
    const shopifyOrders = await fetchAllShopifyOrders(admin, queryStr);

    for (const order of shopifyOrders) {
        const lineItems = order.lineItems?.edges || [];
        for (const itemEdge of lineItems) {
            const node = itemEdge.node;
            const pTitle = node.title || "";
            const vTitle = node.variantTitle || "";
            const name = (vTitle && vTitle !== "Default Title") ? `${pTitle} ${vTitle}` : pTitle;
            const qty = node.quantity || 0;
            const key = name.trim();
            salesMap[key] = (salesMap[key] || 0) + qty;
        }
    }

    const customOrders = await prisma.customOrder.findMany({
        where: {
            createdAt: {
                gte: new Date(`${startDate}T00:00:00Z`),
                lte: new Date(`${endDate}T23:59:59Z`),
            }
        }
    });

    for (const order of customOrders) {
        const items = order.items ? JSON.parse(order.items) : [];
        for (const item of items) {
            const key = (item.title || "").trim();
            const qty = item.quantity || 0;
            salesMap[key] = (salesMap[key] || 0) + qty;
        }
    }

    const salesList = Object.entries(salesMap).map(([itemName, qty]) => ({
        itemName,
        qty
    }));

    salesList.sort((a, b) => {
        if (b.qty !== a.qty) return b.qty - a.qty;
        return a.itemName.localeCompare(b.itemName);
    });

    const salesData = salesList.map((row, idx) => ({
        srNo: idx + 1,
        itemName: row.itemName,
        qty: row.qty
    }));

    const totalQty = salesData.reduce((sum, row) => sum + row.qty, 0);

    const aoa = [
        [],
        [`SALES REPORT OF ${startDate} TO ${endDate}`.toUpperCase()],
        [],
        [],
        [],
        ["SR. NO.", "ITEM NAME", "QTY."],
    ];

    let srNo = 1;
    salesData.forEach(row => {
        aoa.push([srNo++, row.itemName, row.qty]);
    });

    aoa.push(["TOTAL", "", totalQty]);

    const worksheet = xlsx.utils.aoa_to_sheet(aoa);
    const workbook = xlsx.utils.book_new();
    xlsx.utils.book_append_sheet(workbook, worksheet, "Sheet1");

    const buffer = xlsx.write(workbook, { type: "buffer", bookType: "xlsx" });

    return new Response(buffer, {
        status: 200,
        headers: {
            "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            "Content-Disposition": `attachment; filename="SALES_REPORT_${startDate}_TO_${endDate}.xlsx"`,
        },
    });
};
