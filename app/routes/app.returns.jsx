import { json } from "@remix-run/node";
import { useLoaderData, useFetcher, useSubmit, useNavigation } from "@remix-run/react";
import { useState, useCallback, useEffect, useRef } from "react";
import {
    Page, Layout, Card, IndexTable, Button, Badge, Modal, FormLayout,
    TextField, Text, BlockStack, InlineStack, Banner, List, Box
} from "@shopify/polaris";
import prisma from "../db.server";
import { authenticate } from "../shopify.server";

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

function parseItemsSnapshot(json) {
    if (!json) return [];
    try {
        const items = JSON.parse(json);
        return Array.isArray(items) ? items : [];
    } catch {
        return [];
    }
}

// Captures a lightweight [{title, quantity}] snapshot of a parcel's items at
// return time so the table/export never need to re-hit Shopify or re-parse
// CustomOrder JSON later.
async function captureItemsSnapshot({ admin, parcel }) {
    if (parcel.orderId?.startsWith("custom-")) {
        const customId = parseInt(parcel.orderId.replace("custom-", ""), 10);
        const customOrder = await prisma.customOrder.findUnique({ where: { id: customId } });
        const items = customOrder?.items ? JSON.parse(customOrder.items) : [];
        return items.map((i) => ({ title: i.title || "", quantity: i.quantity || 0 }));
    }

    try {
        const response = await admin.graphql(
            `#graphql
            query fulfillmentItems($id: ID!) {
                node(id: $id) {
                    ... on Fulfillment {
                        fulfillmentLineItems(first: 50) {
                            edges { node { lineItem { title quantity } } }
                        }
                    }
                }
            }`,
            { variables: { id: parcel.fulfillmentId } }
        );
        const resJson = await response.json();
        const edges = resJson.data?.node?.fulfillmentLineItems?.edges || [];
        return edges.map((e) => ({
            title: e.node.lineItem?.title || "",
            quantity: e.node.lineItem?.quantity || 0
        }));
    } catch (err) {
        console.error(`Failed to capture items snapshot (parcel ${parcel.id}):`, err);
        return [];
    }
}

// Marks a Parcel returned locally, then attempts a formal Shopify Return
// (returnCreate + reverseFulfillmentOrderDispose). The local status update
// always happens first and is never rolled back if the Shopify side fails -
// Shopify errors are captured on the parcel instead of thrown, mirroring
// syncParcelDelivered in app.deliveries.jsx.
async function syncParcelReturned({ admin, parcel }) {
    const itemsSnapshot = await captureItemsSnapshot({ admin, parcel });

    await prisma.parcel.update({
        where: { id: parcel.id },
        data: {
            dispatchStatus: "returned",
            returnedAt: new Date(),
            returnedItemsSnapshot: JSON.stringify(itemsSnapshot)
        }
    });

    if (parcel.fulfillmentId === "custom" || !parcel.fulfillmentId) {
        return { synced: false, local: true, error: null };
    }

    try {
        const rfRes = await admin.graphql(
            `#graphql
            query returnableFulfillmentsForOrder($orderId: ID!) {
                returnableFulfillments(orderId: $orderId, first: 25) {
                    edges {
                        node {
                            fulfillment { id }
                            returnableFulfillmentLineItems(first: 50) {
                                edges { node { quantity fulfillmentLineItem { id } } }
                            }
                        }
                    }
                }
            }`,
            { variables: { orderId: parcel.orderId } }
        );
        const rfJson = await rfRes.json();
        const matches = rfJson.data?.returnableFulfillments?.edges || [];
        const match = matches.find((e) => e.node.fulfillment?.id === parcel.fulfillmentId);

        if (!match) {
            throw new Error("No returnable line items found for this fulfillment (already returned/refunded, or not eligible).");
        }

        const returnLineItems = match.node.returnableFulfillmentLineItems.edges.map((e) => ({
            fulfillmentLineItemId: e.node.fulfillmentLineItem.id,
            quantity: e.node.quantity
        }));

        if (returnLineItems.length === 0) {
            throw new Error("Fulfillment has no returnable line items.");
        }

        const rcRes = await admin.graphql(
            `#graphql
            mutation returnCreate($returnInput: ReturnInput!) {
                returnCreate(returnInput: $returnInput) {
                    return {
                        id
                        reverseFulfillmentOrders(first: 10) {
                            edges {
                                node {
                                    id
                                    lineItems(first: 50) {
                                        edges { node { id quantity } }
                                    }
                                }
                            }
                        }
                    }
                    userErrors { field message }
                }
            }`,
            { variables: { returnInput: { orderId: parcel.orderId, returnLineItems } } }
        );
        const rcJson = await rcRes.json();
        const rcErrors = rcJson.data?.returnCreate?.userErrors;
        if (rcErrors?.length) {
            throw new Error(rcErrors.map((e) => e.message).join("; "));
        }
        const createdReturn = rcJson.data?.returnCreate?.return;
        if (!createdReturn) {
            throw new Error("returnCreate did not return a Return object.");
        }

        const fulfillmentRes = await admin.graphql(
            `#graphql
            query fulfillmentLocation($id: ID!) {
                node(id: $id) { ... on Fulfillment { location { id } } }
            }`,
            { variables: { id: parcel.fulfillmentId } }
        );
        const fulfillmentJson = await fulfillmentRes.json();
        const locationId = fulfillmentJson.data?.node?.location?.id;

        const rfoEdges = createdReturn.reverseFulfillmentOrders?.edges || [];
        const dispositionInputs = [];
        for (const rfoEdge of rfoEdges) {
            const lineItemEdges = rfoEdge.node.lineItems?.edges || [];
            for (const liEdge of lineItemEdges) {
                dispositionInputs.push({
                    reverseFulfillmentOrderLineItemId: liEdge.node.id,
                    quantity: liEdge.node.quantity,
                    dispositionType: "RESTOCKED",
                    locationId
                });
            }
        }

        if (locationId && dispositionInputs.length > 0) {
            const disposeRes = await admin.graphql(
                `#graphql
                mutation reverseFulfillmentOrderDispose($dispositionInputs: [ReverseFulfillmentOrderDisposeInput!]!) {
                    reverseFulfillmentOrderDispose(dispositionInputs: $dispositionInputs) {
                        reverseFulfillmentOrderLineItems { id }
                        userErrors { field message }
                    }
                }`,
                { variables: { dispositionInputs } }
            );
            const disposeJson = await disposeRes.json();
            const disposeErrors = disposeJson.data?.reverseFulfillmentOrderDispose?.userErrors;
            if (disposeErrors?.length) {
                console.error(`reverseFulfillmentOrderDispose userErrors (parcel ${parcel.id}):`, disposeErrors);
            }
        } else if (dispositionInputs.length > 0) {
            console.warn(`No location found for parcel ${parcel.id}; return created but not disposed/restocked.`);
        }

        await prisma.parcel.update({
            where: { id: parcel.id },
            data: { shopifyReturnId: createdReturn.id, shopifyReturnError: null }
        });

        return { synced: true, local: false, error: null };
    } catch (err) {
        const message = (err?.message || "Unknown error").slice(0, 500);
        console.error(`Shopify return sync failed (parcel ${parcel.id}):`, err);
        await prisma.parcel.update({
            where: { id: parcel.id },
            data: { shopifyReturnError: message }
        });
        return { synced: false, local: false, error: message };
    }
}

export async function loader({ request }) {
    await authenticate.admin(request);

    const url = new URL(request.url);
    const startDate = url.searchParams.get("startDate") || getDefaultStartDate();
    const endDate = url.searchParams.get("endDate") || getDefaultEndDate();
    const validStartDate = dateRegex.test(startDate) ? startDate : getDefaultStartDate();
    const validEndDate = dateRegex.test(endDate) ? endDate : getDefaultEndDate();

    const returnedParcels = await prisma.parcel.findMany({
        where: {
            dispatchStatus: "returned",
            returnedAt: {
                gte: new Date(`${validStartDate}T00:00:00Z`),
                lte: new Date(`${validEndDate}T23:59:59Z`)
            }
        },
        orderBy: { returnedAt: "desc" }
    });

    return json({ returnedParcels, startDate: validStartDate, endDate: validEndDate });
}

export async function action({ request }) {
    const { admin } = await authenticate.admin(request);
    const formData = await request.formData();
    const intent = formData.get("intent");

    if (intent === "fetch_parcel") {
        const awbNumber = String(formData.get("awbNumber")).trim();
        const parcel = await prisma.parcel.findFirst({
            where: { awbNumber: { equals: awbNumber } }
        });

        if (!parcel) {
            return json({ intent: "fetch_parcel", error: `Parcel with AWB "${awbNumber}" not found.`, timestamp: Date.now() + Math.random() });
        }
        if (parcel.dispatchStatus === "returned") {
            return json({ intent: "fetch_parcel", error: `Parcel "${parcel.awbNumber}" has already been returned.`, timestamp: Date.now() + Math.random() });
        }
        if (parcel.dispatchStatus === "pending") {
            return json({ intent: "fetch_parcel", error: `Parcel "${parcel.awbNumber}" was never dispatched, nothing to return.`, timestamp: Date.now() + Math.random() });
        }

        return json({ intent: "fetch_parcel", parcel, success: true, timestamp: Date.now() + Math.random() });
    }

    if (intent === "mark_returned") {
        const parcelIds = formData.getAll("parcelIds[]").map(Number);
        const parcels = await prisma.parcel.findMany({ where: { id: { in: parcelIds } } });

        const results = [];
        for (const parcel of parcels) {
            const result = await syncParcelReturned({ admin, parcel });
            results.push({ awbNumber: parcel.awbNumber, ...result });
        }

        return json({ intent: "mark_returned", results });
    }

    return json({ error: "Invalid intent" }, { status: 400 });
}

export default function Returns() {
    const { returnedParcels, startDate: loaderStartDate, endDate: loaderEndDate } = useLoaderData();
    const fetcher = useFetcher();
    const submit = useSubmit();
    const navigation = useNavigation();
    const isLoading = navigation.state === "loading";

    const [startDate, setStartDate] = useState(loaderStartDate);
    const [endDate, setEndDate] = useState(loaderEndDate);
    const [isExporting, setIsExporting] = useState(false);

    const handlePreview = useCallback(() => {
        const fd = new FormData();
        fd.append("startDate", startDate);
        fd.append("endDate", endDate);
        submit(fd, { method: "get" });
    }, [startDate, endDate, submit]);

    const handleExport = useCallback(async () => {
        setIsExporting(true);
        try {
            const response = await fetch(`/api/returns/download?startDate=${startDate}&endDate=${endDate}`);
            if (!response.ok) throw new Error("Failed to export report");
            const blob = await response.blob();
            const url = window.URL.createObjectURL(blob);
            const a = document.createElement("a");
            a.href = url;
            a.download = `RETURNS_REPORT_${startDate}_TO_${endDate}.xlsx`;
            document.body.appendChild(a);
            a.click();
            a.remove();
            window.URL.revokeObjectURL(url);
        } catch (error) {
            console.error("Export error:", error);
        } finally {
            setIsExporting(false);
        }
    }, [startDate, endDate]);

    // Quick Return wizard state
    const [isWizardOpen, setIsWizardOpen] = useState(false);
    const [wizardStep, setWizardStep] = useState(1);
    const [awbInput, setAwbInput] = useState("");
    const [scannedParcels, setScannedParcels] = useState([]);
    const [scanError, setScanError] = useState("");
    const [scanSuccess, setScanSuccess] = useState("");
    const [notes, setNotes] = useState("");
    const [summaryBanner, setSummaryBanner] = useState(null);
    const inputRef = useRef(null);
    const lastProcessedFetch = useRef(null);

    useEffect(() => {
        if (isWizardOpen && wizardStep === 1 && inputRef.current) {
            setTimeout(() => inputRef.current?.focus(), 100);
        }
    }, [isWizardOpen, wizardStep]);

    const resetWizard = useCallback(() => {
        setWizardStep(1);
        setAwbInput("");
        setScannedParcels([]);
        setScanError("");
        setScanSuccess("");
        setNotes("");
        setIsWizardOpen(false);
    }, []);

    useEffect(() => {
        if (fetcher.state === "idle" && fetcher.data?.intent === "fetch_parcel") {
            if (lastProcessedFetch.current === fetcher.data.timestamp) return;
            lastProcessedFetch.current = fetcher.data.timestamp;

            if (fetcher.data.error) {
                setScanError(fetcher.data.error);
            } else if (fetcher.data.parcel) {
                const parcel = fetcher.data.parcel;
                if (scannedParcels.some((p) => p.id === parcel.id)) {
                    setScanError(`Parcel "${parcel.awbNumber}" has already been scanned.`);
                } else {
                    setScannedParcels((prev) => [...prev, parcel]);
                    setScanSuccess(`Added: ${parcel.awbNumber} (Order ${parcel.orderName})`);
                    setTimeout(() => setScanSuccess(""), 2000);
                }
            }
            setAwbInput("");
            setTimeout(() => inputRef.current?.focus(), 50);
        }

        if (fetcher.state === "idle" && fetcher.data?.intent === "mark_returned") {
            const results = fetcher.data.results || [];
            const synced = results.filter((r) => r.synced).length;
            const local = results.filter((r) => r.local).length;
            const failed = results.filter((r) => !r.synced && !r.local).length;
            setSummaryBanner(
                `${results.length} parcel(s) marked returned locally. ${synced} synced to Shopify, ${local} local-only (custom orders), ${failed} Shopify sync failed.`
            );
        }
    }, [fetcher.state, fetcher.data, scannedParcels]);

    const handleAwbSubmit = (e) => {
        if (e) {
            e.preventDefault();
            e.stopPropagation();
        }
        const awb = awbInput.trim();
        if (!awb) return;

        setScanError("");
        setScanSuccess("");

        if (scannedParcels.some((p) => p.awbNumber.toLowerCase() === awb.toLowerCase())) {
            setScanError(`This parcel (${awb}) has already been scanned.`);
            setAwbInput("");
            setTimeout(() => inputRef.current?.focus(), 50);
            return;
        }

        const formData = new FormData();
        formData.append("intent", "fetch_parcel");
        formData.append("awbNumber", awb);
        fetcher.submit(formData, { method: "post" });
    };

    const removeScannedParcel = (id) => {
        setScannedParcels((prev) => prev.filter((p) => p.id !== id));
    };

    const handleMarkReturned = () => {
        const formData = new FormData();
        formData.append("intent", "mark_returned");
        formData.append("notes", notes);
        scannedParcels.forEach((p) => formData.append("parcelIds[]", p.id));
        fetcher.submit(formData, { method: "post" });
        resetWizard();
    };

    const syncBadge = (row) => {
        if (row.shopifyReturnId) return <Badge tone="success">Synced</Badge>;
        if (row.shopifyReturnError) return <Badge tone="critical">Failed</Badge>;
        return <Badge>Local Only</Badge>;
    };

    const rowMarkup = returnedParcels.map((row, index) => {
        const items = parseItemsSnapshot(row.returnedItemsSnapshot);
        const itemsText = items.length
            ? items.map((i) => `${i.title} x${i.quantity}`).join(", ")
            : "—";

        return (
            <IndexTable.Row id={row.id.toString()} key={row.id} position={index}>
                <IndexTable.Cell>
                    <Text fontWeight="bold" as="span">{row.awbNumber}</Text>
                </IndexTable.Cell>
                <IndexTable.Cell>{row.orderName || "—"}</IndexTable.Cell>
                <IndexTable.Cell>{row.carrierName || "—"}</IndexTable.Cell>
                <IndexTable.Cell>
                    {row.returnedAt ? new Date(row.returnedAt).toLocaleDateString("en-IN", { day: "2-digit", month: "2-digit", year: "numeric" }) : "—"}
                </IndexTable.Cell>
                <IndexTable.Cell>₹{(parseFloat(row.valueOfRepayment) || 0).toFixed(2)}</IndexTable.Cell>
                <IndexTable.Cell>
                    <Text tone="subdued" as="span">{itemsText}</Text>
                </IndexTable.Cell>
                <IndexTable.Cell>{syncBadge(row)}</IndexTable.Cell>
            </IndexTable.Row>
        );
    });

    return (
        <Page
            title="Returns"
            fullWidth
            primaryAction={{
                content: "Quick Return",
                onAction: () => setIsWizardOpen(true)
            }}
        >
            <Layout>
                {summaryBanner && (
                    <Layout.Section>
                        <Banner tone="info" onDismiss={() => setSummaryBanner(null)}>
                            <p>{summaryBanner}</p>
                        </Banner>
                    </Layout.Section>
                )}

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
                                    <Button onClick={handlePreview} loading={isLoading}>
                                        Preview
                                    </Button>
                                    <Button onClick={handleExport} loading={isExporting} disabled={returnedParcels.length === 0}>
                                        Export to Excel
                                    </Button>
                                </InlineStack>
                            </FormLayout>
                        </BlockStack>
                    </Card>
                </Layout.Section>

                <Layout.Section>
                    <Card padding="0">
                        <IndexTable
                            resourceName={{ singular: "returned parcel", plural: "returned parcels" }}
                            itemCount={returnedParcels.length}
                            headings={[
                                { title: "AWB" },
                                { title: "Order" },
                                { title: "Carrier" },
                                { title: "Return Date" },
                                { title: "COD Value" },
                                { title: "Items" },
                                { title: "Shopify Sync" }
                            ]}
                            selectable={false}
                            loading={isLoading}
                        >
                            {rowMarkup}
                        </IndexTable>
                    </Card>
                </Layout.Section>
            </Layout>

            {/* Quick Return Wizard */}
            <Modal
                open={isWizardOpen}
                onClose={resetWizard}
                title={`Quick Return - Step ${wizardStep} of 2`}
                primaryAction={{
                    content: wizardStep === 2 ? "Mark Returned" : "Next",
                    onAction: wizardStep === 2 ? handleMarkReturned : () => setWizardStep(2),
                    disabled: scannedParcels.length === 0
                }}
                secondaryActions={[{ content: "Cancel", onAction: resetWizard }]}
            >
                <Modal.Section>
                    {wizardStep === 1 && (
                        <BlockStack gap="400">
                            {scanError && <Banner tone="critical">{scanError}</Banner>}
                            {scanSuccess && <Banner tone="success">{scanSuccess}</Banner>}
                            <form onSubmit={handleAwbSubmit}>
                                <TextField
                                    ref={inputRef}
                                    label="Scan or Enter AWB Number"
                                    value={awbInput}
                                    onChange={setAwbInput}
                                    onClearButtonClick={() => {
                                        setAwbInput("");
                                        setScanError("");
                                        setScanSuccess("");
                                        setTimeout(() => inputRef.current?.focus(), 50);
                                    }}
                                    clearButton
                                    onKeyDown={(e) => {
                                        if (e.key === "Enter" || e.key === "Tab") {
                                            handleAwbSubmit(e);
                                        }
                                    }}
                                    placeholder="Scan barcode or type AWB..."
                                    autoComplete="off"
                                    connectedRight={
                                        <Button
                                            onClick={() => handleAwbSubmit()}
                                            disabled={!awbInput.trim() || fetcher.state !== "idle"}
                                        >
                                            + Add
                                        </Button>
                                    }
                                />
                            </form>
                            <Text variant="headingMd" as="h3">Scanned Parcels ({scannedParcels.length})</Text>
                            {scannedParcels.length > 0 ? (
                                <List>
                                    {scannedParcels.map((p) => (
                                        <List.Item key={p.id}>
                                            <InlineStack align="space-between">
                                                <Text as="span">{p.awbNumber} - Order {p.orderName}</Text>
                                                <Button variant="plain" tone="critical" onClick={() => removeScannedParcel(p.id)}>Remove</Button>
                                            </InlineStack>
                                        </List.Item>
                                    ))}
                                </List>
                            ) : (
                                <Text tone="subdued" as="span">No parcels scanned yet.</Text>
                            )}
                        </BlockStack>
                    )}

                    {wizardStep === 2 && (
                        <FormLayout>
                            <Text as="p" variant="bodyMd">
                                You are about to mark <strong>{scannedParcels.length}</strong> parcel(s) as returned. This updates each
                                parcel's status locally and attempts a formal Shopify Return for Shopify-fulfilled orders.
                            </Text>
                            <Box>
                                <List>
                                    {scannedParcels.map((p) => (
                                        <List.Item key={p.id}>{p.awbNumber} - Order {p.orderName}</List.Item>
                                    ))}
                                </List>
                            </Box>
                            <TextField
                                label="Notes (Optional)"
                                value={notes}
                                onChange={setNotes}
                                multiline={3}
                            />
                        </FormLayout>
                    )}
                </Modal.Section>
            </Modal>
        </Page>
    );
}
