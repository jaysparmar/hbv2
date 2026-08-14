import { useState, useCallback, useRef, useEffect } from "react";
import { json, unstable_createMemoryUploadHandler, unstable_parseMultipartFormData } from "@remix-run/node";
import { useLoaderData, useSubmit, useNavigation, useActionData } from "@remix-run/react";
import {
    Page, Layout, Card, IndexTable, Text, Button, Modal, TextField, Select,
    BlockStack, InlineStack, IndexFilters, useSetIndexFiltersMode, useIndexResourceState,
    Badge, Banner, Grid, Box
} from "@shopify/polaris";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import XLSX from "xlsx";

const DELIVERIES_PER_PAGE = 25;

function classifyCodStatus(codValue, parcelCodAmount) {
    if (parcelCodAmount === null || parcelCodAmount === undefined) return "not connected";
    const diff = (codValue || 0) - parcelCodAmount;
    if (Math.abs(diff) < 0.01) return "full";
    return diff < 0 ? "less" : "more";
}

// Marks a Parcel delivered locally and pushes a DELIVERED fulfillment event to
// Shopify. Never throws - GraphQL/DB errors are logged so callers (bulk import,
// bulk sync) keep processing remaining rows.
async function syncParcelDelivered({ admin, parcel }) {
    await prisma.parcel.update({
        where: { id: parcel.id },
        data: { dispatchStatus: "delivered" }
    });

    if (parcel.fulfillmentId) {
        try {
            const response = await admin.graphql(
                `#graphql
                mutation fulfillmentEventCreate($fulfillmentEvent: FulfillmentEventInput!) {
                    fulfillmentEventCreate(fulfillmentEvent: $fulfillmentEvent) {
                        fulfillmentEvent { id status happenedAt }
                        userErrors { field message }
                    }
                }`,
                { variables: { fulfillmentEvent: { fulfillmentId: parcel.fulfillmentId, status: "DELIVERED" } } }
            );
            const result = await response.json();
            const userErrors = result.data?.fulfillmentEventCreate?.userErrors;
            if (userErrors?.length) {
                console.error(`fulfillmentEventCreate userErrors (parcel ${parcel.id}):`, userErrors);
            }
        } catch (err) {
            console.error(`fulfillmentEventCreate failed (parcel ${parcel.id}):`, err);
        }
    }
}

// Reconciles a delivery record against the matching Parcel: computes the COD
// collection status and, on first match, syncs "delivered" to Shopify + the
// local Parcel row.
async function reconcileWithParcel({ admin, carrierId, articleNumber, codValue }) {
    const parcel = await prisma.parcel.findFirst({
        where: { carrierId, awbNumber: articleNumber }
    });

    if (!parcel) {
        return { parcelCodAmount: null, codCollectionStatus: "not connected" };
    }

    const parcelCodAmount = parseFloat(parcel.valueOfRepayment) || 0;
    const codCollectionStatus = classifyCodStatus(codValue, parcelCodAmount);

    if (parcel.dispatchStatus !== "delivered") {
        await syncParcelDelivered({ admin, parcel });
    }

    return { parcelCodAmount, codCollectionStatus };
}

function parseReportDate(val) {
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
}

export const loader = async ({ request }) => {
    await authenticate.admin(request);

    const url = new URL(request.url);
    const q = url.searchParams.get("q") || "";
    const page = Math.max(1, parseInt(url.searchParams.get("page") || "1", 10));

    const AND = [];
    if (q) {
        AND.push({
            OR: [
                { articleNumber: { contains: q } },
                { customerName: { contains: q } },
                { officeName: { contains: q } },
            ],
        });
    }
    const where = AND.length > 0 ? { AND } : undefined;

    const [deliveries, totalCount, stats, carriers] = await Promise.all([
        prisma.delivery.findMany({
            where,
            include: { carrier: true },
            orderBy: { updatedAt: "desc" },
            skip: (page - 1) * DELIVERIES_PER_PAGE,
            take: DELIVERIES_PER_PAGE,
        }),
        prisma.delivery.count({ where }),
        prisma.delivery.aggregate({
            _sum: { codValue: true, codCommission: true },
            _count: { id: true },
        }),
        prisma.carrier.findMany({ orderBy: { name: "asc" } }),
    ]);

    const totalPages = Math.max(1, Math.ceil(totalCount / DELIVERIES_PER_PAGE));

    return json({
        deliveries,
        page,
        totalPages,
        totalCount,
        q,
        carriers,
        stats: {
            totalCount: stats._count.id || 0,
            totalCodValue: stats._sum.codValue || 0,
            totalCodCommission: stats._sum.codCommission || 0,
        }
    });
};

export const action = async ({ request }) => {
    const { admin } = await authenticate.admin(request);
    const contentType = request.headers.get("content-type") || "";

    try {
        if (contentType.includes("multipart/form-data")) {
            const uploadHandler = unstable_createMemoryUploadHandler({
                maxPartSize: 10 * 1024 * 1024, // 10MB
            });
            const formData = await unstable_parseMultipartFormData(request, uploadHandler);
            return await handleBulkImport({ admin, formData });
        }

        const formData = await request.formData();
        const actionType = formData.get("actionType");

        if (actionType === "create" || actionType === "update") {
            const carrierId = parseInt(formData.get("carrierId"), 10);
            const articleNumber = (formData.get("articleNumber") || "").toString().trim();

            if (!carrierId || !articleNumber) {
                return json({ status: "error", message: "Carrier and AWB / Article Number are required." }, { status: 400 });
            }

            const codValue = parseFloat(formData.get("codValue")) || 0;
            const { parcelCodAmount, codCollectionStatus } = await reconcileWithParcel({
                admin, carrierId, articleNumber, codValue
            });

            const deliveredDateStr = formData.get("deliveredDate");
            const billDateStr = formData.get("billDate");

            const data = {
                carrierId,
                articleNumber,
                articleCount: parseInt(formData.get("articleCount"), 10) || 1,
                codInvoiceNumber: formData.get("codInvoiceNumber")?.toString() || null,
                deliveredDate: deliveredDateStr ? new Date(deliveredDateStr) : null,
                codValue,
                codCommission: parseFloat(formData.get("codCommission")) || 0,
                officeId: formData.get("officeId")?.toString() || null,
                officeName: formData.get("officeName")?.toString() || null,
                customerId: formData.get("customerId")?.toString() || null,
                customerName: formData.get("customerName")?.toString() || null,
                billDate: billDateStr ? new Date(billDateStr) : null,
                contractId: formData.get("contractId")?.toString() || null,
                contractMode: formData.get("contractMode")?.toString() || null,
                parcelCodAmount,
                codCollectionStatus,
            };

            if (actionType === "create") {
                await prisma.delivery.create({ data });
                return json({ status: "success", message: "Delivery record created." });
            }

            const id = parseInt(formData.get("id"), 10);
            await prisma.delivery.update({ where: { id }, data });
            return json({ status: "success", message: "Delivery record updated." });
        }

        if (actionType === "delete") {
            const id = parseInt(formData.get("id"), 10);
            await prisma.delivery.delete({ where: { id } });
            return json({ status: "success", message: "Delivery record deleted." });
        }

        if (actionType === "syncAll") {
            const deliveries = await prisma.delivery.findMany();
            let syncedCount = 0;
            let alreadyDeliveredCount = 0;
            let notConnectedCount = 0;

            for (const delivery of deliveries) {
                const parcel = await prisma.parcel.findFirst({
                    where: { carrierId: delivery.carrierId, awbNumber: delivery.articleNumber }
                });

                if (!parcel) {
                    notConnectedCount++;
                    if (delivery.codCollectionStatus !== "not connected" || delivery.parcelCodAmount !== null) {
                        await prisma.delivery.update({
                            where: { id: delivery.id },
                            data: { parcelCodAmount: null, codCollectionStatus: "not connected" }
                        });
                    }
                    continue;
                }

                const parcelCodAmount = parseFloat(parcel.valueOfRepayment) || 0;
                const codCollectionStatus = classifyCodStatus(delivery.codValue, parcelCodAmount);

                if (parcel.dispatchStatus === "delivered") {
                    alreadyDeliveredCount++;
                } else {
                    await syncParcelDelivered({ admin, parcel });
                    syncedCount++;
                }

                if (delivery.parcelCodAmount !== parcelCodAmount || delivery.codCollectionStatus !== codCollectionStatus) {
                    await prisma.delivery.update({
                        where: { id: delivery.id },
                        data: { parcelCodAmount, codCollectionStatus }
                    });
                }
            }

            return json({
                status: "success",
                message: `Synced ${syncedCount} parcel(s) to delivered. ${alreadyDeliveredCount} were already delivered. ${notConnectedCount} delivery record(s) have no matching parcel.`
            });
        }

        return json({ status: "error", message: "Unknown action." }, { status: 400 });
    } catch (error) {
        if (error.code === "P2002") {
            return json({ status: "error", message: "A delivery record with this AWB already exists for the selected carrier." }, { status: 409 });
        }
        console.error("Delivery action error:", error);
        return json({ status: "error", message: error.message || "An unexpected error occurred." }, { status: 500 });
    }
};

async function handleBulkImport({ admin, formData }) {
    const carrierId = parseInt(formData.get("carrierId"), 10);
    const file = formData.get("file");

    if (!carrierId) {
        return json({ status: "error", message: "Please select a carrier for this import." }, { status: 400 });
    }

    const carrier = await prisma.carrier.findUnique({ where: { id: carrierId } });
    if (!carrier) {
        return json({ status: "error", message: "Selected carrier not found." }, { status: 404 });
    }

    if (!file || typeof file === "string" || file.size === 0) {
        return json({ status: "error", message: "Please select a valid Excel file to import." }, { status: 400 });
    }

    const filename = file.name || "";
    if (!filename.toLowerCase().endsWith(".xlsx")) {
        return json({ status: "error", message: "Only Excel (.xlsx) files are supported." }, { status: 400 });
    }

    const buffer = Buffer.from(await file.arrayBuffer());
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

    let importedCount = 0;
    let reconciledCount = 0;
    let notConnectedCount = 0;

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
            deliveredDate = parseReportDate(row.delivered_date);
            codValue = parseFloat(row.cod_value) || 0;
            codCommission = parseFloat(row.cod_commission) || 0;
            officeId = row.office_id?.toString() || null;
            officeName = row.office_name?.toString() || null;
            customerId = row.customer_id?.toString() || null;
            customerName = row.customer_name?.toString() || null;
            billDate = parseReportDate(row.bill_date);
            contractId = row.contract_id?.toString() || null;
            contractMode = row.contract_mode?.toString() || null;
        } else if (isPendingPaymentReport) {
            articleNumber = row["Tracking No."]?.toString()?.trim() || "";
            articleCount = 1;
            codInvoiceNumber = row["Vch. No."]?.toString() || null;
            deliveredDate = parseReportDate(row["Delivery Date"]);
            codCommission = parseFloat(row["Courier Charges"]) || 0;
            officeId = row["Pin Code No."]?.toString() || null;

            const city = row["City"]?.toString()?.trim() || "";
            const state = row["State"]?.toString()?.trim() || "";
            officeName = [city, state].filter(Boolean).join(", ") || null;

            customerId = row["Mob. No."]?.toString() || null;
            customerName = row["Customer"]?.toString() || null;
            billDate = parseReportDate(row["Payment Date"]);
            contractId = row["Order No."]?.toString() || null;
            contractMode = row["Order Source"]?.toString() || null;

            if (contractId) {
                const matchedCustomOrder = await prisma.customOrder.findUnique({
                    where: { orderName: contractId }
                });
                if (matchedCustomOrder) {
                    codValue = matchedCustomOrder.totalAmount || 0;
                }
            }

            if (codValue === 0) {
                const matchedParcel = await prisma.parcel.findFirst({
                    where: { carrierId, awbNumber: articleNumber }
                });
                if (matchedParcel && matchedParcel.valueOfRepayment) {
                    codValue = parseFloat(matchedParcel.valueOfRepayment) || 0;
                }
            }

            if (codValue === 0 && contractId) {
                try {
                    const response = await admin.graphql(
                        `#graphql
                        query getOrderByName($query: String!) {
                            orders(first: 1, query: $query) {
                                edges {
                                    node {
                                        totalPriceSet {
                                            shopMoney { amount }
                                        }
                                    }
                                }
                            }
                        }`,
                        { variables: { query: `name:${contractId} OR name:#${contractId}` } }
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

        const { parcelCodAmount, codCollectionStatus } = await reconcileWithParcel({
            admin, carrierId, articleNumber, codValue
        });

        if (codCollectionStatus === "not connected") {
            notConnectedCount++;
        } else {
            reconciledCount++;
        }

        const deliveryFields = {
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
            parcelCodAmount,
            codCollectionStatus,
        };

        await prisma.delivery.upsert({
            where: {
                carrierId_articleNumber: { carrierId, articleNumber }
            },
            update: deliveryFields,
            create: { carrierId, articleNumber, ...deliveryFields }
        });

        importedCount++;
    }

    return json({
        status: "success",
        message: `Imported ${importedCount} delivery record(s): ${reconciledCount} matched to a parcel and marked delivered, ${notConnectedCount} not connected to any parcel.`
    });
}

export default function Deliveries() {
    const { deliveries, page, totalPages, totalCount, q, carriers, stats } = useLoaderData();
    const actionData = useActionData();
    const submit = useSubmit();
    const navigation = useNavigation();

    const isLoading = navigation.state === "loading";
    const isSubmitting = navigation.state === "submitting";

    const carrierOptions = carriers.map((c) => ({ label: c.name, value: c.id.toString() }));

    const { mode, setMode } = useSetIndexFiltersMode();
    const [queryValue, setQueryValue] = useState(q);
    const timeoutId = useRef(null);

    useEffect(() => {
        setQueryValue(q);
    }, [q]);

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

    // Create / edit modal state
    const [isFormModalOpen, setIsFormModalOpen] = useState(false);
    const [editingDelivery, setEditingDelivery] = useState(null);
    const [carrierId, setCarrierId] = useState("");
    const [articleNumber, setArticleNumber] = useState("");
    const [articleCount, setArticleCount] = useState("1");
    const [codInvoiceNumber, setCodInvoiceNumber] = useState("");
    const [deliveredDate, setDeliveredDate] = useState("");
    const [codValue, setCodValue] = useState("0");
    const [codCommission, setCodCommission] = useState("0");
    const [officeId, setOfficeId] = useState("");
    const [officeName, setOfficeName] = useState("");
    const [customerId, setCustomerId] = useState("");
    const [customerName, setCustomerName] = useState("");
    const [billDate, setBillDate] = useState("");
    const [contractId, setContractId] = useState("");
    const [contractMode, setContractMode] = useState("");

    // Bulk import modal state
    const [isUploadModalOpen, setIsUploadModalOpen] = useState(false);
    const [uploadCarrierId, setUploadCarrierId] = useState("");
    const [selectedFile, setSelectedFile] = useState(null);
    const [uploadError, setUploadError] = useState(null);
    const fileInputRef = useRef(null);

    useEffect(() => {
        if (actionData?.status === "success") {
            setIsFormModalOpen(false);
            setIsUploadModalOpen(false);
            setSelectedFile(null);
            setUploadError(null);
        } else if (actionData?.status === "error") {
            setUploadError(actionData.message);
        }
    }, [actionData]);

    const toDateInputValue = (value) => {
        if (!value) return "";
        const d = new Date(value);
        if (isNaN(d.getTime())) return "";
        return d.toISOString().slice(0, 10);
    };

    const resetForm = useCallback(() => {
        setEditingDelivery(null);
        setCarrierId(carriers[0] ? carriers[0].id.toString() : "");
        setArticleNumber("");
        setArticleCount("1");
        setCodInvoiceNumber("");
        setDeliveredDate("");
        setCodValue("0");
        setCodCommission("0");
        setOfficeId("");
        setOfficeName("");
        setCustomerId("");
        setCustomerName("");
        setBillDate("");
        setContractId("");
        setContractMode("");
    }, [carriers]);

    const handleOpenCreate = useCallback(() => {
        resetForm();
        setIsFormModalOpen(true);
    }, [resetForm]);

    const handleCloseForm = useCallback(() => {
        setIsFormModalOpen(false);
        resetForm();
    }, [resetForm]);

    const handleEdit = useCallback((delivery) => {
        setEditingDelivery(delivery);
        setCarrierId(delivery.carrierId.toString());
        setArticleNumber(delivery.articleNumber);
        setArticleCount(delivery.articleCount.toString());
        setCodInvoiceNumber(delivery.codInvoiceNumber || "");
        setDeliveredDate(toDateInputValue(delivery.deliveredDate));
        setCodValue(delivery.codValue.toString());
        setCodCommission(delivery.codCommission.toString());
        setOfficeId(delivery.officeId || "");
        setOfficeName(delivery.officeName || "");
        setCustomerId(delivery.customerId || "");
        setCustomerName(delivery.customerName || "");
        setBillDate(toDateInputValue(delivery.billDate));
        setContractId(delivery.contractId || "");
        setContractMode(delivery.contractMode || "");
        setIsFormModalOpen(true);
    }, []);

    const handleDelete = useCallback((id) => {
        if (confirm("Are you sure you want to delete this delivery record? This will not revert the parcel's delivered status.")) {
            submit({ actionType: "delete", id: id.toString() }, { method: "post" });
        }
    }, [submit]);

    const handleSave = useCallback(() => {
        const formData = {
            actionType: editingDelivery ? "update" : "create",
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
        };
        if (editingDelivery) {
            formData.id = editingDelivery.id.toString();
        }
        submit(formData, { method: "post" });
    }, [editingDelivery, carrierId, articleNumber, articleCount, codInvoiceNumber, deliveredDate, codValue, codCommission, officeId, officeName, customerId, customerName, billDate, contractId, contractMode, submit]);

    const handleChooseFile = useCallback(() => {
        fileInputRef.current?.click();
    }, []);

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

    const handleOpenUpload = useCallback(() => {
        setUploadCarrierId(carriers[0] ? carriers[0].id.toString() : "");
        setSelectedFile(null);
        setUploadError(null);
        setIsUploadModalOpen(true);
    }, [carriers]);

    const handleSyncAll = useCallback(() => {
        if (confirm("Sync all delivery records against parcels now? This will mark every matched parcel as delivered in Shopify and update its status locally.")) {
            submit({ actionType: "syncAll" }, { method: "post" });
        }
    }, [submit]);

    const handleImportSubmit = () => {
        if (!uploadCarrierId) {
            setUploadError("Please select a carrier first.");
            return;
        }
        if (!selectedFile) {
            setUploadError("Please select a file first.");
            return;
        }
        const fd = new FormData();
        fd.append("actionType", "bulkImport");
        fd.append("carrierId", uploadCarrierId);
        fd.append("file", selectedFile);
        submit(fd, { method: "post", encType: "multipart/form-data" });
    };

    const codStatusBadge = (status) => {
        switch (status) {
            case "full":
                return <Badge tone="success">Full</Badge>;
            case "less":
                return <Badge tone="critical">Less</Badge>;
            case "more":
                return <Badge tone="attention">More</Badge>;
            case "not connected":
                return <Badge>Not Connected</Badge>;
            default:
                return <Badge>Pending</Badge>;
        }
    };

    const resourceName = { singular: "delivery", plural: "deliveries" };
    const { selectedResources, allResourcesSelected, handleSelectionChange } = useIndexResourceState(deliveries);

    const rowMarkup = deliveries.map((delivery, index) => (
        <IndexTable.Row id={delivery.id.toString()} key={delivery.id} position={index}>
            <IndexTable.Cell>
                <Text variant="bodyMd" fontWeight="bold" as="span">{delivery.articleNumber}</Text>
            </IndexTable.Cell>
            <IndexTable.Cell>
                <Text as="span">{delivery.carrier?.name || "—"}</Text>
            </IndexTable.Cell>
            <IndexTable.Cell>
                {delivery.deliveredDate ? new Date(delivery.deliveredDate).toLocaleDateString('en-IN', {
                    day: '2-digit', month: '2-digit', year: 'numeric'
                }) : <Text tone="subdued">—</Text>}
            </IndexTable.Cell>
            <IndexTable.Cell>
                <Text variant="bodyMd" as="span">₹{delivery.codValue.toFixed(2)}</Text>
            </IndexTable.Cell>
            <IndexTable.Cell>
                {delivery.parcelCodAmount !== null && delivery.parcelCodAmount !== undefined ? (
                    <Text variant="bodyMd" as="span">₹{delivery.parcelCodAmount.toFixed(2)}</Text>
                ) : <Text tone="subdued">—</Text>}
            </IndexTable.Cell>
            <IndexTable.Cell>
                {codStatusBadge(delivery.codCollectionStatus)}
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
            <IndexTable.Cell>
                <InlineStack gap="200">
                    <Button size="micro" onClick={() => handleEdit(delivery)}>Edit</Button>
                    <Button size="micro" tone="critical" onClick={() => handleDelete(delivery.id)}>Delete</Button>
                </InlineStack>
            </IndexTable.Cell>
        </IndexTable.Row>
    ));

    return (
        <Page
            title="Deliveries"
            fullWidth
            primaryAction={{
                content: "Create Delivery",
                onAction: handleOpenCreate,
            }}
            secondaryActions={[
                {
                    content: "Bulk Import Delivery Report",
                    onAction: handleOpenUpload,
                },
                {
                    content: "Sync Parcels",
                    onAction: handleSyncAll,
                    loading: isSubmitting,
                },
            ]}
        >
            <Layout>
                <Layout.Section>
                    <Grid columns={{ xs: 1, sm: 1, md: 2, lg: 3, xl: 3 }} gap={{ xs: "400", md: "400" }}>
                        <Grid.Cell>
                            <Card>
                                <BlockStack gap="200">
                                    <Text variant="headingSm" tone="subdued" as="h3">Total Deliveries</Text>
                                    <Text variant="headingLg" as="p">{stats.totalCount}</Text>
                                </BlockStack>
                            </Card>
                        </Grid.Cell>
                        <Grid.Cell>
                            <Card>
                                <BlockStack gap="200">
                                    <Text variant="headingSm" tone="subdued" as="h3">Total COD Value Collected</Text>
                                    <Text variant="headingLg" as="p" tone="success">₹{stats.totalCodValue.toLocaleString('en-IN', { minimumFractionDigits: 2 })}</Text>
                                </BlockStack>
                            </Card>
                        </Grid.Cell>
                        <Grid.Cell>
                            <Card>
                                <BlockStack gap="200">
                                    <Text variant="headingSm" tone="subdued" as="h3">Total COD Commission</Text>
                                    <Text variant="headingLg" as="p" tone="warning">₹{stats.totalCodCommission.toLocaleString('en-IN', { minimumFractionDigits: 2 })}</Text>
                                </BlockStack>
                            </Card>
                        </Grid.Cell>
                    </Grid>
                </Layout.Section>

                {actionData?.status === "success" && (
                    <Layout.Section>
                        <Banner tone="success" title="Success">
                            <p>{actionData.message}</p>
                        </Banner>
                    </Layout.Section>
                )}
                {actionData?.status === "error" && !isFormModalOpen && !isUploadModalOpen && (
                    <Layout.Section>
                        <Banner tone="critical" title="Error">
                            <p>{actionData.message}</p>
                        </Banner>
                    </Layout.Section>
                )}

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
                                { title: "AWB / Article Number" },
                                { title: "Carrier" },
                                { title: "Delivered Date" },
                                { title: "COD Value" },
                                { title: "Parcel COD Amount" },
                                { title: "COD Collection Status" },
                                { title: "Customer" },
                                { title: "Post Office" },
                                { title: "Contract Mode" },
                                { title: "Actions" },
                            ]}
                            selectable={false}
                            loading={isLoading}
                        >
                            {rowMarkup}
                        </IndexTable>

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

            {/* Create / Edit Modal */}
            <Modal
                open={isFormModalOpen}
                onClose={handleCloseForm}
                title={editingDelivery ? "Edit Delivery" : "Create Delivery"}
                primaryAction={{
                    content: "Save",
                    onAction: handleSave,
                    loading: isSubmitting,
                    disabled: !carrierId || !articleNumber,
                }}
                secondaryActions={[
                    { content: "Cancel", onAction: handleCloseForm },
                ]}
            >
                <Modal.Section>
                    <BlockStack gap="400">
                        {actionData?.status === "error" && isFormModalOpen && (
                            <Banner tone="critical"><p>{actionData.message}</p></Banner>
                        )}
                        <Select
                            label="Carrier"
                            options={carrierOptions}
                            value={carrierId}
                            onChange={setCarrierId}
                        />
                        <TextField
                            label="AWB / Article Number"
                            value={articleNumber}
                            onChange={setArticleNumber}
                            autoComplete="off"
                        />
                        <TextField
                            label="Article Count"
                            type="number"
                            value={articleCount}
                            onChange={setArticleCount}
                            autoComplete="off"
                        />
                        <TextField
                            label="COD Invoice Number"
                            value={codInvoiceNumber}
                            onChange={setCodInvoiceNumber}
                            autoComplete="off"
                        />
                        <TextField
                            label="Delivered Date"
                            type="date"
                            value={deliveredDate}
                            onChange={setDeliveredDate}
                            autoComplete="off"
                        />
                        <TextField
                            label="COD Value (collected as per report)"
                            type="number"
                            value={codValue}
                            onChange={setCodValue}
                            autoComplete="off"
                        />
                        <TextField
                            label="COD Commission"
                            type="number"
                            value={codCommission}
                            onChange={setCodCommission}
                            autoComplete="off"
                        />
                        <TextField
                            label="Office ID"
                            value={officeId}
                            onChange={setOfficeId}
                            autoComplete="off"
                        />
                        <TextField
                            label="Office Name"
                            value={officeName}
                            onChange={setOfficeName}
                            autoComplete="off"
                        />
                        <TextField
                            label="Customer ID"
                            value={customerId}
                            onChange={setCustomerId}
                            autoComplete="off"
                        />
                        <TextField
                            label="Customer Name"
                            value={customerName}
                            onChange={setCustomerName}
                            autoComplete="off"
                        />
                        <TextField
                            label="Bill Date"
                            type="date"
                            value={billDate}
                            onChange={setBillDate}
                            autoComplete="off"
                        />
                        <TextField
                            label="Contract ID"
                            value={contractId}
                            onChange={setContractId}
                            autoComplete="off"
                        />
                        <TextField
                            label="Contract Mode"
                            value={contractMode}
                            onChange={setContractMode}
                            autoComplete="off"
                        />
                    </BlockStack>
                </Modal.Section>
            </Modal>

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
                    disabled: !selectedFile || !uploadCarrierId,
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
                            Upload an India Post Excel delivery report (`.xlsx`) to record deliveries, reconcile COD amounts, and update parcel tracking statuses automatically.
                        </Text>

                        <Select
                            label="Carrier"
                            options={carrierOptions}
                            value={uploadCarrierId}
                            onChange={setUploadCarrierId}
                        />

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
