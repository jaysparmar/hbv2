import { useState, useCallback, useRef, useEffect } from "react";
import { json, unstable_createMemoryUploadHandler, unstable_parseMultipartFormData } from "@remix-run/node";
import { useLoaderData, useSubmit, useNavigate, useNavigation, useActionData } from "@remix-run/react";
import {
    Page, Layout, Card, IndexTable, Text, Button, Modal, BlockStack,
    InlineStack, IndexFilters, useSetIndexFiltersMode, useIndexResourceState,
    Badge, Banner, Grid, Box
} from "@shopify/polaris";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import XLSX from "xlsx";

const DELIVERIES_PER_PAGE = 25;

export const loader = async ({ request, params }) => {
    await authenticate.admin(request);
    const carrierId = parseInt(params.id, 10);

    const carrier = await prisma.carrier.findUnique({
        where: { id: carrierId },
    });

    if (!carrier) {
        throw new Response("Carrier Not Found", { status: 404 });
    }

    const url = new URL(request.url);
    const q = url.searchParams.get("q") || "";
    const page = Math.max(1, parseInt(url.searchParams.get("page") || "1", 10));

    const AND = [{ carrierId }];
    if (q) {
        AND.push({
            OR: [
                { articleNumber: { contains: q } },
                { customerName: { contains: q } },
                { officeName: { contains: q } },
            ],
        });
    }

    const where = { AND };

    // Fetch paginated deliveries and aggregate stats
    const [deliveries, totalCount, stats] = await Promise.all([
        prisma.delivery.findMany({
            where,
            orderBy: { deliveredDate: "desc" },
            skip: (page - 1) * DELIVERIES_PER_PAGE,
            take: DELIVERIES_PER_PAGE,
        }),
        prisma.delivery.count({ where }),
        prisma.delivery.aggregate({
            where: { carrierId },
            _sum: {
                codValue: true,
                codCommission: true,
            },
            _count: {
                id: true,
            }
        })
    ]);

    const totalPages = Math.max(1, Math.ceil(totalCount / DELIVERIES_PER_PAGE));

    return json({
        carrier,
        deliveries,
        page,
        totalPages,
        totalCount,
        q,
        stats: {
            totalCount: stats._count.id || 0,
            totalCodValue: stats._sum.codValue || 0,
            totalCodCommission: stats._sum.codCommission || 0,
        }
    });
};

export const action = async ({ request, params }) => {
    const { admin } = await authenticate.admin(request);
    const carrierId = parseInt(params.id, 10);

    const carrier = await prisma.carrier.findUnique({
        where: { id: carrierId }
    });
    if (!carrier) {
        return json({ status: "error", message: "Carrier not found" }, { status: 404 });
    }

    try {
        const uploadHandler = unstable_createMemoryUploadHandler({
            maxPartSize: 10 * 1024 * 1024, // 10MB
        });
        const formData = await unstable_parseMultipartFormData(request, uploadHandler);
        const file = formData.get("file");

        if (!file || typeof file === "string" || file.size === 0) {
            return json({ status: "error", message: "Please select a valid Excel file to import." }, { status: 400 });
        }

        const filename = file.name || "";
        if (!filename.toLowerCase().endsWith(".xlsx")) {
            return json({ status: "error", message: "Only Excel (.xlsx) files are supported." }, { status: 400 });
        }

        const buffer = Buffer.from(await file.arrayBuffer());
        
        // Disable XML external entity expansion implicitly via sheetjs' default secure reading behaviour
        const workbook = XLSX.read(buffer, { type: "buffer", cellDates: true });
        
        if (!workbook.SheetNames.length) {
            return json({ status: "error", message: "The uploaded Excel file has no sheets." }, { status: 400 });
        }

        const sheetName = workbook.SheetNames[0];
        const sheet = workbook.Sheets[sheetName];
        const rows = XLSX.utils.sheet_to_json(sheet);

        if (!rows.length) {
            return json({ status: "error", message: "No rows found in the first sheet." }, { status: 400 });
        }

        const sampleRow = rows[0];
        let isIndiaPostReport = false;
        let isPendingPaymentReport = false;

        if ("article_number" in sampleRow) {
            isIndiaPostReport = true;
        } else if ("Tracking No." in sampleRow) {
            isPendingPaymentReport = true;
        } else {
            return json({
                status: "error",
                message: "Invalid format: The Excel file is neither a standard India Post Delivery Report (missing 'article_number') nor a Pending Payment Report (missing 'Tracking No.')."
            }, { status: 400 });
        }

        const parseDate = (val) => {
            if (!val) return null;
            if (val instanceof Date) return val;
            
            // Handle DD-MM-YYYY strings
            const s = val.toString().trim();
            const parts = s.split("-");
            if (parts.length === 3) {
                const day = parseInt(parts[0], 10);
                const month = parseInt(parts[1], 10) - 1;
                const year = parseInt(parts[2], 10);
                if (!isNaN(day) && !isNaN(month) && !isNaN(year)) {
                    const d = new Date(year, month, day);
                    return isNaN(d.getTime()) ? null : d;
                }
            }
            
            const d = new Date(val);
            return isNaN(d.getTime()) ? null : d;
        };

        let importedCount = 0;
        let syncedParcelCount = 0;

        // Process sequentially to handle DB operations safely
        for (const row of rows) {
            let articleNumber = "";
            let articleCount = 1;
            let codInvoiceNumber = null;
            let deliveredDate = null;
            let codValue = 0;
            let codCommission = 0;
            let officeId = null;
            let officeName = null;
            let customerId = null;
            let customerName = null;
            let billDate = null;
            let contractId = null;
            let contractMode = null;

            if (isIndiaPostReport) {
                articleNumber = row.article_number?.toString()?.trim() || "";
                articleCount = parseInt(row.article_count, 10) || 1;
                codInvoiceNumber = row.cod_invoice_number?.toString() || null;
                deliveredDate = parseDate(row.delivered_date);
                codValue = parseFloat(row.cod_value) || 0;
                codCommission = parseFloat(row.cod_commission) || 0;
                officeId = row.office_id?.toString() || null;
                officeName = row.office_name?.toString() || null;
                customerId = row.customer_id?.toString() || null;
                customerName = row.customer_name?.toString() || null;
                billDate = parseDate(row.bill_date);
                contractId = row.contract_id?.toString() || null;
                contractMode = row.contract_mode?.toString() || null;
            } else if (isPendingPaymentReport) {
                articleNumber = row["Tracking No."]?.toString()?.trim() || "";
                articleCount = 1;
                codInvoiceNumber = row["Vch. No."]?.toString() || null;
                deliveredDate = parseDate(row["Delivery Date"]);
                codCommission = parseFloat(row["Courier Charges"]) || 0;
                officeId = row["Pin Code No."]?.toString() || null;
                
                const city = row["City"]?.toString()?.trim() || "";
                const state = row["State"]?.toString()?.trim() || "";
                officeName = [city, state].filter(Boolean).join(", ") || null;
                
                customerId = row["Mob. No."]?.toString() || null;
                customerName = row["Customer"]?.toString() || null;
                billDate = parseDate(row["Payment Date"]);
                contractId = row["Order No."]?.toString() || null;
                contractMode = row["Order Source"]?.toString() || null;

                // 1. Try to find the matching custom order
                if (contractId) {
                    const matchedCustomOrder = await prisma.customOrder.findUnique({
                        where: { orderName: contractId }
                    });
                    if (matchedCustomOrder) {
                        codValue = matchedCustomOrder.totalAmount || 0;
                    }
                }

                // 2. Try to find the matching parcel to fetch the COD amount
                if (codValue === 0) {
                    const matchedParcel = await prisma.parcel.findFirst({
                        where: {
                            carrierId,
                            awbNumber: articleNumber
                        }
                    });
                    if (matchedParcel && matchedParcel.valueOfRepayment) {
                        codValue = parseFloat(matchedParcel.valueOfRepayment) || 0;
                    }
                }

                // 3. Fetch from Shopify Admin API if not found locally
                if (codValue === 0 && contractId) {
                    try {
                        const response = await admin.graphql(
                            `#graphql
                            query getOrderByName($query: String!) {
                                orders(first: 1, query: $query) {
                                    edges {
                                        node {
                                            totalPriceSet {
                                                shopMoney {
                                                    amount
                                                }
                                            }
                                        }
                                    }
                                }
                            }`,
                            {
                                variables: {
                                    query: `name:${contractId} OR name:#${contractId}`
                                }
                            }
                        );
                        const resJson = await response.json();
                        const edges = resJson.data?.orders?.edges || [];
                        if (edges.length > 0) {
                            const amountStr = edges[0].node.totalPriceSet?.shopMoney?.amount;
                            codValue = parseFloat(amountStr) || 0;
                        }
                    } catch (err) {
                        console.error(`Error fetching order ${contractId} from Shopify:`, err);
                    }
                }
            }

            if (!articleNumber) continue;

            // Upsert delivery record
            await prisma.delivery.upsert({
                where: {
                    carrierId_articleNumber: {
                        carrierId,
                        articleNumber,
                    }
                },
                update: {
                    articleCount,
                    codInvoiceNumber,
                    deliveredDate,
                    codValue,
                    codCommission,
                    officeId,
                    officeName,
                    customerId,
                    customerName,
                    billDate,
                    contractId,
                    contractMode,
                },
                create: {
                    carrierId,
                    articleNumber,
                    articleCount,
                    codInvoiceNumber,
                    deliveredDate,
                    codValue,
                    codCommission,
                    officeId,
                    officeName,
                    customerId,
                    customerName,
                    billDate,
                    contractId,
                    contractMode,
                }
            });

            importedCount++;

            // Sync Parcel status to 'delivered'
            const syncResult = await prisma.parcel.updateMany({
                where: {
                    carrierId,
                    awbNumber: articleNumber
                },
                data: {
                    dispatchStatus: "delivered"
                }
            });

            syncedParcelCount += syncResult.count;
        }

        return json({
            status: "success",
            message: `Successfully imported ${importedCount} delivery records and synchronized ${syncedParcelCount} parcel statuses.`
        });

    } catch (error) {
        console.error("Excel import error:", error);
        return json({
            status: "error",
            message: error.message || "An unexpected error occurred while processing the file."
        }, { status: 500 });
    }
};

export default function CarrierDeliveries() {
    const { carrier, deliveries, page, totalPages, totalCount, q, stats } = useLoaderData();
    const actionData = useActionData();
    const submit = useSubmit();
    const navigate = useNavigate();
    const navigation = useNavigation();

    const isLoading = navigation.state === "loading";
    const isSubmitting = navigation.state === "submitting";

    const [isUploadModalOpen, setIsUploadModalOpen] = useState(false);
    const [selectedFile, setSelectedFile] = useState(null);
    const [uploadError, setUploadError] = useState(null);

    const { mode, setMode } = useSetIndexFiltersMode();
    const [queryValue, setQueryValue] = useState(q);
    const timeoutId = useRef(null);
    const fileInputRef = useRef(null);

    const handleChooseFile = useCallback(() => {
        fileInputRef.current?.click();
    }, []);

    useEffect(() => {
        setQueryValue(q);
    }, [q]);

    useEffect(() => {
        if (actionData?.status === "success") {
            setIsUploadModalOpen(false);
            setSelectedFile(null);
            setUploadError(null);
        } else if (actionData?.status === "error") {
            setUploadError(actionData.message);
        }
    }, [actionData]);

    const handleFiltersQueryChange = useCallback(
        (value) => {
            setQueryValue(value);
            if (timeoutId.current) clearTimeout(timeoutId.current);
            timeoutId.current = setTimeout(() => {
                const formData = new FormData();
                if (value) formData.append("q", value);
                submit(formData, { method: "get" });
            }, 500);
        },
        [submit]
    );

    const handleFiltersClearAll = useCallback(() => {
        setQueryValue("");
        submit({}, { method: "get" });
    }, [submit]);

    const handleFileChange = (event) => {
        const file = event.target.files[0];
        if (file) {
            if (!file.name.toLowerCase().endsWith(".xlsx")) {
                setUploadError("Invalid file type. Please upload an Excel (.xlsx) file.");
                setSelectedFile(null);
                return;
            }
            if (file.size > 10 * 1024 * 1024) {
                setUploadError("File is too large. Max allowed size is 10MB.");
                setSelectedFile(null);
                return;
            }
            setUploadError(null);
            setSelectedFile(file);
        }
    };

    const handleImportSubmit = () => {
        if (!selectedFile) {
            setUploadError("Please select a file first.");
            return;
        }
        const fd = new FormData();
        fd.append("file", selectedFile);
        submit(fd, { method: "post", encType: "multipart/form-data" });
    };

    const resourceName = { singular: "delivery", plural: "deliveries" };
    const { selectedResources, allResourcesSelected, handleSelectionChange } = useIndexResourceState(deliveries);

    const rowMarkup = deliveries.map((delivery, index) => (
        <IndexTable.Row id={delivery.id.toString()} key={delivery.id} position={index}>
            <IndexTable.Cell>
                <Text variant="bodyMd" fontWeight="bold" as="span">{delivery.articleNumber}</Text>
            </IndexTable.Cell>
            <IndexTable.Cell>
                {delivery.deliveredDate ? new Date(delivery.deliveredDate).toLocaleDateString('en-IN', {
                    day: '2-digit', month: '2-digit', year: 'numeric'
                }) : <Text tone="subdued">—</Text>}
            </IndexTable.Cell>
            <IndexTable.Cell>
                {delivery.billDate ? new Date(delivery.billDate).toLocaleDateString('en-IN', {
                    day: '2-digit', month: '2-digit', year: 'numeric'
                }) : <Text tone="subdued">—</Text>}
            </IndexTable.Cell>
            <IndexTable.Cell>
                <Text variant="bodyMd" as="span">₹{delivery.codValue.toFixed(2)}</Text>
            </IndexTable.Cell>
            <IndexTable.Cell>
                <Text variant="bodyMd" as="span">₹{delivery.codCommission.toFixed(2)}</Text>
            </IndexTable.Cell>
            <IndexTable.Cell>
                <BlockStack>
                    <Text variant="bodyMd" fontWeight="semibold" as="span">{delivery.customerName || "—"}</Text>
                    {delivery.customerId && <Text variant="bodyXs" tone="subdued" as="span">ID: {delivery.customerId}</Text>}
                </BlockStack>
            </IndexTable.Cell>
            <IndexTable.Cell>
                <BlockStack>
                    <Text variant="bodyMd" as="span">{delivery.officeName || "—"}</Text>
                    {delivery.officeId && <Text variant="bodyXs" tone="subdued" as="span">ID: {delivery.officeId}</Text>}
                </BlockStack>
            </IndexTable.Cell>
            <IndexTable.Cell>
                {delivery.contractMode ? (
                    <Badge tone={delivery.contractMode.toLowerCase() === "advance" ? "success" : "info"}>
                        {delivery.contractMode}
                    </Badge>
                ) : <Text tone="subdued">—</Text>}
            </IndexTable.Cell>
        </IndexTable.Row>
    ));

    return (
        <Page
            title={`Deliveries - ${carrier.name}`}
            backAction={{ content: "Carriers", onAction: () => navigate("/app/carriers") }}
            primaryAction={{
                content: "Bulk Import Delivery Report",
                onAction: () => setIsUploadModalOpen(true),
            }}
        >
            <Layout>
                {/* Stats Summary Cards */}
                <Layout.Section>
                    <Grid columns={{ xs: 1, sm: 3, md: 3 }}>
                        <Grid.Cell>
                            <Card>
                                <BlockStack gap="100">
                                    <Text variant="headingSm" tone="subdued" as="h3">Total Imported Deliveries</Text>
                                    <Text variant="headingLg" as="p">{stats.totalCount}</Text>
                                </BlockStack>
                            </Card>
                        </Grid.Cell>
                        <Grid.Cell>
                            <Card>
                                <BlockStack gap="100">
                                    <Text variant="headingSm" tone="subdued" as="h3">Total COD Value Collected</Text>
                                    <Text variant="headingLg" as="p" tone="success">₹{stats.totalCodValue.toLocaleString('en-IN', { minimumFractionDigits: 2 })}</Text>
                                </BlockStack>
                            </Card>
                        </Grid.Cell>
                        <Grid.Cell>
                            <Card>
                                <BlockStack gap="100">
                                    <Text variant="headingSm" tone="subdued" as="h3">Total COD Commission</Text>
                                    <Text variant="headingLg" as="p" tone="warning">₹{stats.totalCodCommission.toLocaleString('en-IN', { minimumFractionDigits: 2 })}</Text>
                                </BlockStack>
                            </Card>
                        </Grid.Cell>
                    </Grid>
                </Layout.Section>

                {/* Import Status Alert Banner */}
                {actionData?.status === "success" && (
                    <Layout.Section>
                        <Banner tone="success" title="Import Successful">
                            <p>{actionData.message}</p>
                        </Banner>
                    </Layout.Section>
                )}

                {/* Main Deliveries List IndexTable */}
                <Layout.Section>
                    <Card padding="0">
                        <IndexFilters
                            sortOptions={[]}
                            sortSelected={[]}
                            onSort={() => { }}
                            queryValue={queryValue}
                            queryPlaceholder="Search by AWB, customer, or office"
                            onQueryChange={handleFiltersQueryChange}
                            onQueryClear={handleFiltersClearAll}
                            cancelAction={{
                                onAction: () => { },
                                disabled: false,
                                loading: false,
                            }}
                            tabs={[{ content: 'All', id: 'all' }]}
                            selected={0}
                            onSelect={() => { }}
                            canCreateNewView={false}
                            filters={[]}
                            appliedFilters={[]}
                            onClearAll={handleFiltersClearAll}
                            mode={mode}
                            setMode={setMode}
                        />
                        <IndexTable
                            resourceName={resourceName}
                            itemCount={deliveries.length}
                            selectedItemsCount={
                                allResourcesSelected ? "All" : selectedResources.length
                            }
                            onSelectionChange={handleSelectionChange}
                            headings={[
                                { title: "Article Number (AWB)" },
                                { title: "Delivered Date" },
                                { title: "Bill Date" },
                                { title: "COD Value" },
                                { title: "COD Commission" },
                                { title: "Customer" },
                                { title: "Post Office" },
                                { title: "Contract Mode" },
                            ]}
                            selectable={false}
                            loading={isLoading}
                        >
                            {rowMarkup}
                        </IndexTable>
                        
                        {/* Pagination Footer */}
                        {totalPages > 1 && (
                            <div style={{ padding: "16px", display: "flex", justifyContent: "center", alignItems: "center", gap: "12px", borderTop: "1px solid var(--p-color-border)" }}>
                                <Button
                                    disabled={page <= 1}
                                    onClick={() => {
                                        const fd = new FormData();
                                        if (queryValue) fd.append("q", queryValue);
                                        fd.append("page", (page - 1).toString());
                                        submit(fd, { method: "get" });
                                    }}
                                    size="micro"
                                >
                                    Previous
                                </Button>
                                <Text as="span" tone="subdued">
                                    Page {page} of {totalPages} ({totalCount} deliveries)
                                </Text>
                                <Button
                                    disabled={page >= totalPages}
                                    onClick={() => {
                                        const fd = new FormData();
                                        if (queryValue) fd.append("q", queryValue);
                                        fd.append("page", (page + 1).toString());
                                        submit(fd, { method: "get" });
                                    }}
                                    size="micro"
                                >
                                    Next
                                </Button>
                            </div>
                        )}
                    </Card>
                </Layout.Section>
            </Layout>

            {/* Bulk Import Modal */}
            <Modal
                open={isUploadModalOpen}
                onClose={() => {
                    setIsUploadModalOpen(false);
                    setSelectedFile(null);
                    setUploadError(null);
                }}
                title="Bulk Import Delivery Report"
                primaryAction={{
                    content: "Import",
                    onAction: handleImportSubmit,
                    loading: isSubmitting,
                    disabled: !selectedFile,
                }}
                secondaryActions={[
                    {
                        content: "Cancel",
                        onAction: () => {
                            setIsUploadModalOpen(false);
                            setSelectedFile(null);
                            setUploadError(null);
                        },
                    },
                ]}
            >
                <Modal.Section>
                    <BlockStack gap="400">
                        <Text as="p">
                            Upload your India Post Excel delivery report (`.xlsx`) to record deliveries and update parcel tracking statuses automatically.
                        </Text>
                        
                        {uploadError && (
                            <Banner tone="critical">
                                <p>{uploadError}</p>
                            </Banner>
                        )}

                        <Box padding="400" borderStyle="dashed" borderWidth="025" borderColor="border" borderRadius="200">
                            <BlockStack gap="200" align="center">
                                <input
                                    type="file"
                                    accept=".xlsx"
                                    onChange={handleFileChange}
                                    ref={fileInputRef}
                                    style={{ display: "none" }}
                                />
                                <Button onClick={handleChooseFile} variant="secondary">
                                    Choose File
                                </Button>
                                {selectedFile ? (
                                    <Text variant="bodyMd" fontWeight="semibold" tone="success">
                                        Selected: {selectedFile.name} ({(selectedFile.size / 1024).toFixed(1)} KB)
                                    </Text>
                                ) : (
                                    <Text tone="subdued">No file chosen (Accepts .xlsx files up to 10MB)</Text>
                                )}
                            </BlockStack>
                        </Box>
                    </BlockStack>
                </Modal.Section>
            </Modal>
        </Page>
    );
}
