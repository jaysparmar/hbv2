import { json } from "@remix-run/node";
import { useLoaderData, useSubmit, useNavigation, useSearchParams, useFetcher } from "@remix-run/react";
import {
    Page, Layout, Card, IndexTable, Text, Badge, Link, InlineStack,
    IndexFilters, useSetIndexFiltersMode, useIndexResourceState, ChoiceList,
    Button, Modal, BlockStack, Banner, Icon
} from "@shopify/polaris";
import { ReceiptIcon } from "@shopify/polaris-icons";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { useState, useCallback, useRef, useEffect } from "react";
import { printLabel } from "../utils/printLabel";
import { printInvoice } from "../utils/printInvoice";

const PARCELS_PER_PAGE = 25;

export const loader = async ({ request }) => {
    await authenticate.admin(request);
    const url = new URL(request.url);
    const q = url.searchParams.get("q") || "";
    const dispatchStatusParam = url.searchParams.get("dispatchStatus") || "";
    const page = Math.max(1, parseInt(url.searchParams.get("page") || "1", 10));

    const AND = [];
    if (q) {
        AND.push({
            OR: [
                { orderName: { contains: q } },
                { carrierName: { contains: q } },
                { awbNumber: { contains: q } }
            ]
        });
    }

    if (dispatchStatusParam) {
        const statuses = dispatchStatusParam.split(",");
        AND.push({ dispatchStatus: { in: statuses } });
    }

    const where = AND.length > 0 ? { AND } : undefined;

    const [parcels, totalCount] = await Promise.all([
        prisma.parcel.findMany({
            where,
            orderBy: { createdAt: "desc" },
            skip: (page - 1) * PARCELS_PER_PAGE,
            take: PARCELS_PER_PAGE,
        }),
        prisma.parcel.count({ where }),
    ]);

    const totalPages = Math.max(1, Math.ceil(totalCount / PARCELS_PER_PAGE));
    return json({ parcels, q, dispatchStatusParam, page, totalPages, totalCount });
};

export const action = async ({ request }) => {
    const { admin } = await authenticate.admin(request);
    const formData = await request.formData();
    const actionType = formData.get("actionType");

    let errors = [];

    if (actionType === "deleteParcel") {
        const parcelId = parseInt(formData.get("parcelId"), 10);
        const parcel = await prisma.parcel.findUnique({ where: { id: parcelId } });

        if (!parcel) {
            errors = [{ message: "Parcel not found." }];
        } else if (parcel.dispatchmentId !== null) {
            errors = [{ message: "Cannot delete: this parcel is linked to a dispatch. Remove it from the dispatch first." }];
        } else {
            // Cancel the Shopify fulfillment
            const cancelResponse = await admin.graphql(
                `#graphql
        mutation fulfillmentCancel($id: ID!) {
          fulfillmentCancel(id: $id) {
            fulfillment {
              id
              status
            }
            userErrors {
              field
              message
            }
          }
        }`,
                { variables: { id: parcel.fulfillmentId } }
            );
            const cancelResult = await cancelResponse.json();
            const cancelErrors = cancelResult.data?.fulfillmentCancel?.userErrors;
            if (cancelErrors && cancelErrors.length > 0) {
                const realErrors = cancelErrors.filter(
                    (e) => !e.message.toLowerCase().includes("already cancelled") &&
                        !e.message.toLowerCase().includes("cannot cancel")
                );
                if (realErrors.length > 0) {
                    errors = realErrors;
                }
            }
            if (errors.length === 0) {
                await prisma.parcel.delete({ where: { id: parcelId } });
                return json({ errors, deleted: true });
            }
        }
    }

    return json({ errors, deleted: false });
};

export default function ParcelsMaster() {
    const { parcels, q, dispatchStatusParam, page, totalPages, totalCount } = useLoaderData();
    const submit = useSubmit();
    const navigation = useNavigation();

    const isLoading = navigation.state === "loading";
    const isSubmitting = navigation.state === "submitting";

    const { mode, setMode } = useSetIndexFiltersMode();
    const [queryValue, setQueryValue] = useState(q);
    const [dispatchStatusValue, setDispatchStatusValue] = useState(dispatchStatusParam ? dispatchStatusParam.split(",") : []);
    const timeoutId = useRef(null);

    // Delete modal state
    const [deleteModalOpen, setDeleteModalOpen] = useState(false);
    const [parcelToDelete, setParcelToDelete] = useState(null);
    const [deleteError, setDeleteError] = useState(null);

    // Print label state
    const labelFetcher = useFetcher();
    const [printingParcelId, setPrintingParcelId] = useState(null);
    const [printingParcel, setPrintingParcel] = useState(null);

    const handlePrintLabel = useCallback((parcel) => {
        setPrintingParcelId(parcel.id);
        setPrintingParcel(parcel);
        const fd = new FormData();
        fd.append("intent", "getLabelData");
        fd.append("orderId", parcel.orderId);
        labelFetcher.submit(fd, { method: "post", action: "/api/print-label" });
    }, [labelFetcher]);

    useEffect(() => {
        if (labelFetcher.state !== "idle" || !labelFetcher.data) return;
        if (labelFetcher.data.intent === "getLabelData" && printingParcel) {
            if (labelFetcher.data.order && labelFetcher.data.shop) {
                printLabel({
                    order: labelFetcher.data.order,
                    shop: labelFetcher.data.shop,
                    parcel: printingParcel,
                });
            }
            setPrintingParcelId(null);
            setPrintingParcel(null);
        }
    }, [labelFetcher.state, labelFetcher.data, printingParcel]);

    // Print invoice state
    const invoiceFetcher = useFetcher();
    const [invoiceParcelId, setInvoiceParcelId] = useState(null);

    const handlePrintInvoice = useCallback((parcel) => {
        setInvoiceParcelId(parcel.id);
        const fd = new FormData();
        fd.append("intent", "getLabelData");
        fd.append("orderId", parcel.orderId);
        invoiceFetcher.submit(fd, { method: "post", action: "/api/print-label" });
    }, [invoiceFetcher]);

    useEffect(() => {
        if (invoiceFetcher.state !== "idle" || !invoiceFetcher.data) return;
        if (invoiceFetcher.data.intent === "getLabelData" && invoiceParcelId) {
            if (invoiceFetcher.data.order && invoiceFetcher.data.shop) {
                printInvoice({ order: invoiceFetcher.data.order, shop: invoiceFetcher.data.shop });
            }
            setInvoiceParcelId(null);
        }
    }, [invoiceFetcher.state, invoiceFetcher.data, invoiceParcelId]);

    useEffect(() => {
        setQueryValue(q);
        setDispatchStatusValue(dispatchStatusParam ? dispatchStatusParam.split(",") : []);
    }, [q, dispatchStatusParam]);

    // Clear error when modal closes / re-opens
    const openDeleteModal = useCallback((parcel) => {
        setParcelToDelete(parcel);
        setDeleteError(null);
        setDeleteModalOpen(true);
    }, []);

    const closeDeleteModal = useCallback(() => {
        setDeleteModalOpen(false);
        setParcelToDelete(null);
        setDeleteError(null);
    }, []);

    const handleDeleteParcel = useCallback(() => {
        if (!parcelToDelete) return;
        if (parcelToDelete.dispatchmentId !== null) {
            setDeleteError("This parcel is linked to a dispatch and cannot be deleted.");
            return;
        }
        submit(
            { actionType: "deleteParcel", parcelId: parcelToDelete.id.toString() },
            { method: "post" }
        );
        closeDeleteModal();
    }, [parcelToDelete, submit, closeDeleteModal]);

    const handleFiltersQueryChange = useCallback(
        (value) => {
            setQueryValue(value);
            if (timeoutId.current) clearTimeout(timeoutId.current);
            timeoutId.current = setTimeout(() => {
                const formData = new FormData();
                if (value) formData.append("q", value);
                if (dispatchStatusValue.length) formData.append("dispatchStatus", dispatchStatusValue.join(","));
                submit(formData, { method: "get" });
            }, 500);
        },
        [dispatchStatusValue, submit]
    );

    const handleDispatchStatusChange = useCallback((value) => {
        setDispatchStatusValue(value);
        const formData = new FormData();
        if (queryValue) formData.append("q", queryValue);
        if (value.length) formData.append("dispatchStatus", value.join(","));
        submit(formData, { method: "get" });
    }, [queryValue, submit]);

    const handleFiltersClearAll = useCallback(() => {
        setQueryValue("");
        setDispatchStatusValue([]);
        submit({}, { method: "get" });
    }, [submit]);

    const filters = [
        {
            key: "dispatchStatus",
            label: "Dispatch Status",
            filter: (
                <ChoiceList
                    title="Dispatch Status"
                    titleHidden
                    choices={[
                        { label: "Pending", value: "pending" },
                        { label: "Dispatched", value: "dispatched" },
                        { label: "Delivered", value: "delivered" },
                        { label: "Cancelled", value: "cancelled" },
                    ]}
                    selected={dispatchStatusValue}
                    onChange={handleDispatchStatusChange}
                    allowMultiple
                />
            ),
            shortcut: true,
        }
    ];

    const appliedFilters = [];
    if (dispatchStatusValue.length > 0) {
        appliedFilters.push({
            key: "dispatchStatus",
            label: `Status: ${dispatchStatusValue.join(", ")}`,
            onRemove: () => {
                setDispatchStatusValue([]);
                const formData = new FormData();
                if (queryValue) formData.append("q", queryValue);
                submit(formData, { method: "get" });
            },
        });
    }

    const resourceName = { singular: "parcel", plural: "parcels" };
    const { selectedResources, allResourcesSelected, handleSelectionChange } = useIndexResourceState(parcels);

    const getStatusBadge = (status) => {
        switch (status.toLowerCase()) {
            case "pending":
                return <Badge tone="warning">Pending</Badge>;
            case "dispatched":
                return <Badge tone="info">Dispatched</Badge>;
            case "delivered":
                return <Badge tone="success">Delivered</Badge>;
            case "cancelled":
                return <Badge tone="critical">Cancelled</Badge>;
            default:
                return <Badge>{status}</Badge>;
        }
    };

    const rowMarkup = parcels.map((parcel, index) => (
        <IndexTable.Row id={parcel.id.toString()} key={parcel.id} position={index}>
            <IndexTable.Cell>
                <Link url={`/app/orders/${parcel.orderId.split("/").pop()}`}>
                    {parcel.orderName || parcel.orderId.split("/").pop()}
                </Link>
            </IndexTable.Cell>
            <IndexTable.Cell>
                <Text as="span">{parcel.carrierName}</Text>
            </IndexTable.Cell>
            <IndexTable.Cell>
                <Text as="span" fontWeight="bold">{parcel.awbNumber}</Text>
            </IndexTable.Cell>
            <IndexTable.Cell>
                <Text as="span">{parcel.length}x{parcel.width}x{parcel.height} ({parcel.weight}kg)</Text>
            </IndexTable.Cell>
            <IndexTable.Cell>
                {getStatusBadge(parcel.dispatchStatus)}
            </IndexTable.Cell>
            <IndexTable.Cell>
                {parcel.dispatchmentId ? (
                    <Link url={`/app/dispatches/${parcel.dispatchmentId}`}>
                        #{parcel.dispatchmentId}
                    </Link>
                ) : (
                    <Text as="span" tone="subdued">—</Text>
                )}
            </IndexTable.Cell>
            <IndexTable.Cell>
                <Text as="span" tone="subdued">
                    {new Date(parcel.createdAt).toLocaleDateString()}
                </Text>
            </IndexTable.Cell>
            <IndexTable.Cell>
                <InlineStack gap="200">
                    <Button
                        size="micro"
                        icon={ReceiptIcon}
                        onClick={() => handlePrintInvoice(parcel)}
                        loading={invoiceParcelId === parcel.id}
                        accessibilityLabel="Print Invoice"
                    />
                    <Button
                        size="micro"
                        onClick={() => handlePrintLabel(parcel)}
                        loading={printingParcelId === parcel.id}
                    >
                        Print Label
                    </Button>
                    <Button
                        tone="critical"
                        size="micro"
                        onClick={() => openDeleteModal(parcel)}
                        disabled={isSubmitting}
                    >
                        Delete
                    </Button>
                </InlineStack>
            </IndexTable.Cell>
        </IndexTable.Row>
    ));

    return (
        <Page
            title="Parcels (Fulfillments)"
            subtitle="History of all generated parcels and tracking numbers."
        >
            <Layout>
                <Layout.Section>
                    <Card padding="0">
                        <IndexFilters
                            sortOptions={[]}
                            sortSelected={[]}
                            onSort={() => { }}
                            queryValue={queryValue}
                            queryPlaceholder="Search by order name, carrier, or AWB"
                            onQueryChange={handleFiltersQueryChange}
                            onQueryClear={() => {
                                setQueryValue("");
                                const formData = new FormData();
                                if (dispatchStatusValue.length) formData.append("dispatchStatus", dispatchStatusValue.join(","));
                                submit(formData, { method: "get" });
                            }}
                            cancelAction={{
                                onAction: () => { },
                                disabled: false,
                                loading: false,
                            }}
                            tabs={[{ content: 'All', id: 'all' }]}
                            selected={0}
                            onSelect={() => { }}
                            canCreateNewView={false}
                            filters={filters}
                            appliedFilters={appliedFilters}
                            onClearAll={handleFiltersClearAll}
                            mode={mode}
                            setMode={setMode}
                        />
                        <IndexTable
                            resourceName={resourceName}
                            itemCount={parcels.length}
                            selectedItemsCount={
                                allResourcesSelected ? "All" : selectedResources.length
                            }
                            onSelectionChange={handleSelectionChange}
                            headings={[
                                { title: "Order ID" },
                                { title: "Carrier" },
                                { title: "AWB Number" },
                                { title: "Dimensions (L x W x H) & W" },
                                { title: "Dispatch Status" },
                                { title: "Dispatch" },
                                { title: "Created At" },
                                { title: "Actions" },
                            ]}
                            selectable={false}
                            loading={isLoading}
                        >
                            {rowMarkup}
                        </IndexTable>
                        {/* Pagination */}
                        <div style={{ padding: "16px", display: "flex", justifyContent: "center", alignItems: "center", gap: "12px", borderTop: "1px solid var(--p-color-border)" }}>
                            <Button
                                disabled={page <= 1}
                                onClick={() => {
                                    const fd = new FormData();
                                    if (queryValue) fd.append("q", queryValue);
                                    if (dispatchStatusValue.length) fd.append("dispatchStatus", dispatchStatusValue.join(","));
                                    fd.append("page", (page - 1).toString());
                                    submit(fd, { method: "get" });
                                }}
                                size="micro"
                            >
                                Previous
                            </Button>
                            <Text as="span" tone="subdued">
                                Page {page} of {totalPages} ({totalCount} parcels)
                            </Text>
                            <Button
                                disabled={page >= totalPages}
                                onClick={() => {
                                    const fd = new FormData();
                                    if (queryValue) fd.append("q", queryValue);
                                    if (dispatchStatusValue.length) fd.append("dispatchStatus", dispatchStatusValue.join(","));
                                    fd.append("page", (page + 1).toString());
                                    submit(fd, { method: "get" });
                                }}
                                size="micro"
                            >
                                Next
                            </Button>
                        </div>
                    </Card>
                </Layout.Section>
            </Layout>

            {/* DELETE PARCEL CONFIRMATION MODAL */}
            <Modal
                open={deleteModalOpen}
                onClose={closeDeleteModal}
                title="Delete Parcel"
                primaryAction={{
                    content: "Delete",
                    onAction: handleDeleteParcel,
                    destructive: true,
                    loading: isSubmitting,
                    disabled: parcelToDelete?.dispatchmentId !== null && parcelToDelete?.dispatchmentId !== undefined,
                }}
                secondaryActions={[{ content: "Cancel", onAction: closeDeleteModal }]}
            >
                <Modal.Section>
                    <BlockStack gap="300">
                        <Text as="p">Are you sure you want to delete this parcel?</Text>
                        {parcelToDelete && (
                            <Text as="p" tone="subdued">
                                AWB: <strong>{parcelToDelete.awbNumber || "—"}</strong> · Carrier: {parcelToDelete.carrierName}
                            </Text>
                        )}
                        {parcelToDelete?.dispatchmentId && (
                            <Banner tone="warning">
                                This parcel is linked to <strong>Dispatch #{parcelToDelete.dispatchmentId}</strong> and cannot be deleted until it is removed from the dispatch.
                            </Banner>
                        )}
                        {parcelToDelete && !parcelToDelete.dispatchmentId && (
                            <Banner tone="critical">
                                This will also <strong>cancel</strong> the associated Shopify fulfillment. This action cannot be undone.
                            </Banner>
                        )}
                        {deleteError && (
                            <Banner tone="critical">{deleteError}</Banner>
                        )}
                    </BlockStack>
                </Modal.Section>
            </Modal>
        </Page>
    );
}
