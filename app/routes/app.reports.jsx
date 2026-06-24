import { useState, useCallback } from "react";
import { json } from "@remix-run/node";
import { useLoaderData, useSubmit, useNavigation } from "@remix-run/react";
import {
    Page,
    Layout,
    Card,
    FormLayout,
    TextField,
    Button,
    IndexTable,
    Text,
    BlockStack,
    InlineStack,
    Box,
    Spinner,
    Banner,
    Tabs,
    Badge
} from "@shopify/polaris";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import * as xlsx from "xlsx";

const dateRegex = /^\d{4}-\d{2}-\d{2}$/;

function getDefaultStartDate() {
    const today = new Date();
    const yyyy = today.getFullYear();
    const mm = String(today.getMonth() + 1).padStart(2, "0");
    return `${yyyy}-${mm}-01`;
}

function getDefaultEndDate() {
    const today = new Date();
    const yyyy = today.getFullYear();
    const mm = String(today.getMonth() + 1).padStart(2, "0");
    const dd = String(today.getDate()).padStart(2, "0");
    return `${yyyy}-${mm}-${dd}`;
}

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
    const startDate = url.searchParams.get("startDate") || getDefaultStartDate();
    const endDate = url.searchParams.get("endDate") || getDefaultEndDate();
    const reportType = url.searchParams.get("reportType") || "sales";

    // Validate inputs
    if (!dateRegex.test(startDate) || !dateRegex.test(endDate)) {
        return json({ error: "Invalid date format. Please use YYYY-MM-DD." }, { status: 400 });
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

        const deliveriesData = deliveries.map((row, idx) => {
            const remainingAmount = row.billDate ? 0 : row.codValue;
            return {
                srNo: idx + 1,
                vchNo: row.codInvoiceNumber || row.id.toString(),
                date: formatDDMMYYYY(row.createdAt),
                orderNo: row.contractId || "",
                customer: row.customerName || "",
                mobNo: row.customerId || "",
                trackingNo: row.articleNumber || "",
                deliveryDate: formatDDMMYYYY(row.deliveredDate),
                paymentDate: formatDDMMYYYY(row.billDate),
                courierCharges: row.codCommission || 0,
                remainingAmount,
                source: row.contractMode || "",
                completed: row.billDate ? "Yes" : "No"
            };
        });

        const totalRemaining = deliveriesData.reduce((sum, r) => sum + r.remainingAmount, 0);

        return json({ deliveriesData, totalRemaining, reportType, startDate, endDate });
    }

    // --- SALES REPORT ---
    // 1. Fetch Shopify variants
    const allVariants = await fetchAllShopifyVariants(admin);

    // Initialize mapping with 0 qty
    const salesMap = {};
    for (const v of allVariants) {
        const name = v.displayName.replace(" - ", " ").trim();
        salesMap[name] = 0;
    }

    // 2. Fetch standard orders from Shopify
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

    // 3. Fetch custom orders from Prisma database
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

    // Convert to flat list
    const salesList = Object.entries(salesMap).map(([itemName, qty]) => ({
        itemName,
        qty
    }));

    // Sort by quantity descending, then alphabetically by item name
    salesList.sort((a, b) => {
        if (b.qty !== a.qty) return b.qty - a.qty;
        return a.itemName.localeCompare(b.itemName);
    });

    // Format final list with SR. NO.
    const salesData = salesList.map((row, idx) => ({
        srNo: idx + 1,
        itemName: row.itemName,
        qty: row.qty
    }));

    const totalQty = salesData.reduce((sum, row) => sum + row.qty, 0);

    return json({ salesData, totalQty, reportType, startDate, endDate });
};

export default function Reports() {
    const data = useLoaderData();
    const submit = useSubmit();
    const navigation = useNavigation();

    const reportType = data.reportType || "sales";
    const [startDate, setStartDate] = useState(data.startDate || getDefaultStartDate());
    const [endDate, setEndDate] = useState(data.endDate || getDefaultEndDate());
    const [isExporting, setIsExporting] = useState(false);
    const [selectedTab, setSelectedTab] = useState(reportType === "payments" ? 1 : 0);

    const isSubmitting = navigation.state === "loading" || navigation.state === "submitting";

    const tabs = [
        {
            id: 'sales-report',
            content: 'Sales Report',
            panelID: 'sales-report-panel',
        },
        {
            id: 'payments-report',
            content: 'Pending Payment Report',
            panelID: 'payments-report-panel',
        },
    ];

    const handleTabChange = useCallback(
        (selectedTabIndex) => {
            setSelectedTab(selectedTabIndex);
            const type = selectedTabIndex === 1 ? "payments" : "sales";
            const fd = new FormData();
            fd.append("reportType", type);
            fd.append("startDate", startDate);
            fd.append("endDate", endDate);
            submit(fd, { method: "get" });
        },
        [startDate, endDate, submit]
    );

    const handlePreview = useCallback(() => {
        const type = selectedTab === 1 ? "payments" : "sales";
        const fd = new FormData();
        fd.append("reportType", type);
        fd.append("startDate", startDate);
        fd.append("endDate", endDate);
        submit(fd, { method: "get" });
    }, [startDate, endDate, selectedTab, submit]);

    const handleExport = useCallback(async () => {
        setIsExporting(true);
        const type = selectedTab === 1 ? "payments" : "sales";
        const filename = type === "payments" 
            ? `PENDING_PAYMENT_REPORT_${startDate}_TO_${endDate}.xlsx` 
            : `SALES_REPORT_${startDate}_TO_${endDate}.xlsx`;
        try {
            const response = await fetch(`/api/reports/download?reportType=${type}&startDate=${startDate}&endDate=${endDate}`);
            if (!response.ok) throw new Error("Failed to export report");
            const blob = await response.blob();
            const url = window.URL.createObjectURL(blob);
            const a = document.createElement("a");
            a.href = url;
            a.download = filename;
            document.body.appendChild(a);
            a.click();
            a.remove();
            window.URL.revokeObjectURL(url);
        } catch (error) {
            console.error("Export error:", error);
        } finally {
            setIsExporting(false);
        }
    }, [startDate, endDate, selectedTab]);

    if (data.error) {
        return (
            <Page title="Reports" backAction={{ content: "Orders", url: "/app" }}>
                <Banner tone="critical"><p>{data.error}</p></Banner>
            </Page>
        );
    }

    const { salesData = [], totalQty = 0, deliveriesData = [], totalRemaining = 0 } = data;
    const isPayments = selectedTab === 1;

    const resourceNameSales = { singular: "item", plural: "items" };
    const resourceNamePayments = { singular: "delivery", plural: "deliveries" };

    return (
        <Page
            title="Reports"
            backAction={{ content: "Orders", url: "/app" }}
            primaryAction={{
                content: "Export to Excel",
                onAction: handleExport,
                loading: isExporting,
                disabled: isSubmitting || (isPayments ? deliveriesData.length === 0 : salesData.length === 0)
            }}
        >
            <Layout>
                <Layout.Section>
                    <Card padding="0">
                        <Tabs tabs={tabs} selected={selectedTab} onSelect={handleTabChange} />
                    </Card>
                </Layout.Section>

                <Layout.Section>
                    <Card>
                        <BlockStack gap="400">
                            <Text variant="headingMd" as="h2">Select Date Range</Text>
                            <FormLayout>
                                <FormLayout.Group>
                                    <TextField
                                        label="Start Date"
                                        type="date"
                                        value={startDate}
                                        onChange={setStartDate}
                                        autoComplete="off"
                                    />
                                    <TextField
                                        label="End Date"
                                        type="date"
                                        value={endDate}
                                        onChange={setEndDate}
                                        autoComplete="off"
                                    />
                                </FormLayout.Group>
                                <InlineStack gap="300">
                                    <Button onClick={handlePreview} loading={isSubmitting}>
                                        Preview Report
                                    </Button>
                                </InlineStack>
                            </FormLayout>
                        </BlockStack>
                    </Card>
                </Layout.Section>

                <Layout.Section>
                    <Card padding="0">
                        {isSubmitting ? (
                            <Box padding="800" align="center">
                                <Spinner size="large" />
                                <Box paddingBlockStart="400">
                                    <Text as="p" tone="subdued">Generating report...</Text>
                                </Box>
                            </Box>
                        ) : isPayments ? (
                            <BlockStack>
                                <Box padding="400" borderBlockEndWidth="025" borderColor="border">
                                    <InlineStack align="space-between">
                                        <Text variant="headingSm" as="h3">Deliveries Preview</Text>
                                        <Badge tone="warning">Total Pending: ₹{totalRemaining.toFixed(2)}</Badge>
                                    </InlineStack>
                                </Box>
                                <IndexTable
                                    resourceName={resourceNamePayments}
                                    itemCount={deliveriesData.length}
                                    headings={[
                                        { title: "SR. NO." },
                                        { title: "Vch. No." },
                                        { title: "Date" },
                                        { title: "Order No." },
                                        { title: "Customer" },
                                        { title: "Tracking No. (AWB)" },
                                        { title: "Delivery Date" },
                                        { title: "Payment Date" },
                                        { title: "Courier Charges" },
                                        { title: "Order Source" },
                                        { title: "Completed" }
                                    ]}
                                    selectable={false}
                                >
                                    {deliveriesData.map((row, index) => (
                                        <IndexTable.Row id={row.trackingNo} key={row.trackingNo} position={index}>
                                            <IndexTable.Cell>{row.srNo}</IndexTable.Cell>
                                            <IndexTable.Cell>{row.vchNo}</IndexTable.Cell>
                                            <IndexTable.Cell>{row.date}</IndexTable.Cell>
                                            <IndexTable.Cell>{row.orderNo}</IndexTable.Cell>
                                            <IndexTable.Cell>
                                                <BlockStack>
                                                    <Text fontWeight="semibold" as="span">{row.customer}</Text>
                                                    {row.mobNo && <Text variant="bodyXs" tone="subdued" as="span">Mob: {row.mobNo}</Text>}
                                                </BlockStack>
                                            </IndexTable.Cell>
                                            <IndexTable.Cell>
                                                <Text fontWeight="bold" as="span">{row.trackingNo}</Text>
                                            </IndexTable.Cell>
                                            <IndexTable.Cell>{row.deliveryDate || "—"}</IndexTable.Cell>
                                            <IndexTable.Cell>{row.paymentDate || "—"}</IndexTable.Cell>
                                            <IndexTable.Cell>₹{row.courierCharges}</IndexTable.Cell>
                                            <IndexTable.Cell>{row.source || "—"}</IndexTable.Cell>
                                            <IndexTable.Cell>
                                                <Badge tone={row.completed === "Yes" ? "success" : "warning"}>
                                                    {row.completed === "Yes" ? "Completed" : "Pending"}
                                                </Badge>
                                            </IndexTable.Cell>
                                        </IndexTable.Row>
                                    ))}
                                </IndexTable>
                            </BlockStack>
                        ) : (
                            <IndexTable
                                resourceName={resourceNameSales}
                                itemCount={salesData.length}
                                headings={[
                                    { title: "SR. NO." },
                                    { title: "ITEM NAME" },
                                    { title: "QTY." }
                                ]}
                                selectable={false}
                            >
                                {salesData.map((row, index) => (
                                    <IndexTable.Row id={row.itemName} key={row.itemName} position={index}>
                                        <IndexTable.Cell>{row.srNo}</IndexTable.Cell>
                                        <IndexTable.Cell>
                                            <Text fontWeight="bold" as="span">{row.itemName}</Text>
                                        </IndexTable.Cell>
                                        <IndexTable.Cell>{row.qty}</IndexTable.Cell>
                                    </IndexTable.Row>
                                ))}
                                <IndexTable.Row id="total-row" position={salesData.length} disabled>
                                    <IndexTable.Cell>
                                        <Text fontWeight="bold" as="span">TOTAL</Text>
                                    </IndexTable.Cell>
                                    <IndexTable.Cell></IndexTable.Cell>
                                    <IndexTable.Cell>
                                        <Text fontWeight="bold" as="span">{totalQty}</Text>
                                    </IndexTable.Cell>
                                </IndexTable.Row>
                            </IndexTable>
                        )}
                    </Card>
                </Layout.Section>
            </Layout>
        </Page>
    );
}
