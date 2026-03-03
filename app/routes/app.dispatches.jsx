import { json } from "@remix-run/node";
import { useLoaderData, useFetcher } from "@remix-run/react";
import { useState, useCallback, useEffect, useRef } from "react";
import {
    Page, Layout, Card, IndexTable, Button, Badge, Modal, FormLayout,
    Select, TextField, Text, BlockStack, InlineStack, Banner, List
} from "@shopify/polaris";
import { DeliveryIcon, DeleteIcon, CheckIcon } from "@shopify/polaris-icons";
import db from "../db.server";
import { authenticate } from "../shopify.server";

export async function loader({ request }) {
    await authenticate.admin(request);
    const dispatches = await db.dispatchment.findMany({
        include: {
            carrier: true,
            _count: {
                select: { parcels: true }
            }
        },
        orderBy: { createdAt: "desc" }
    });

    const activeCarriers = await db.carrier.findMany({
        where: { isActive: true }
    });

    const pendingParcels = await db.parcel.findMany({
        where: { dispatchStatus: "pending" }
    });

    return json({ dispatches, activeCarriers, pendingParcels });
}

export async function action({ request }) {
    const { session } = await authenticate.admin(request);
    const formData = await request.formData();
    const intent = formData.get("intent");

    if (intent === "create_dispatch") {
        const carrierId = Number(formData.get("carrierId"));
        const notes = formData.get("notes") || "";
        const parcelIds = formData.getAll("parcelIds[]").map(Number);

        await db.$transaction(async (tx) => {
            const dispatchment = await tx.dispatchment.create({
                data: {
                    carrierId,
                    notes,
                    transitStatus: "pending"
                }
            });

            await tx.parcel.updateMany({
                where: { id: { in: parcelIds } },
                data: {
                    dispatchStatus: "dispatched",
                    dispatchmentId: dispatchment.id
                }
            });
        });

        return json({ success: true });
    }

    if (intent === "toggle_transit_status") {
        const id = Number(formData.get("id"));
        const currentStatus = formData.get("currentStatus");
        const newStatus = currentStatus === "pending" ? "sent" : "pending";

        await db.dispatchment.update({
            where: { id },
            data: { transitStatus: newStatus }
        });
        return json({ success: true });
    }

    if (intent === "delete_dispatch") {
        const id = Number(formData.get("id"));
        await db.$transaction(async (tx) => {
            await tx.parcel.updateMany({
                where: { dispatchmentId: id },
                data: {
                    dispatchStatus: "pending",
                    dispatchmentId: null
                }
            });
            await tx.dispatchment.delete({
                where: { id }
            });
        });
        return json({ success: true });
    }

    if (intent === "fetch_parcel") {
        const awbNumber = String(formData.get("awbNumber")).trim();
        const parcel = await db.parcel.findFirst({
            where: {
                // Using SQLite case-insensitive filter workaround
                awbNumber: {
                    equals: awbNumber
                }
            }
        });

        if (!parcel) {
            return json({ intent: "fetch_parcel", error: `Parcel with AWB "${awbNumber}" not found.`, timestamp: Date.now() + Math.random() });
        }
        return json({ intent: "fetch_parcel", parcel, success: true, timestamp: Date.now() + Math.random() });
    }

    return json({ error: "Invalid intent" }, { status: 400 });
}

export default function Dispatches() {
    const { dispatches, activeCarriers, pendingParcels } = useLoaderData();
    const fetcher = useFetcher();

    const [isWizardOpen, setIsWizardOpen] = useState(false);
    const [wizardStep, setWizardStep] = useState(1);

    // Step 1 State
    const [selectedCarrier, setSelectedCarrier] = useState("");

    // Step 2 State
    const [awbInput, setAwbInput] = useState("");
    const [scannedParcels, setScannedParcels] = useState([]);
    const [scanError, setScanError] = useState("");
    const [scanSuccess, setScanSuccess] = useState("");
    const inputRef = useRef(null);

    // Auto-focus input when modal opens to Step 2
    useEffect(() => {
        if (isWizardOpen && wizardStep === 2 && inputRef.current) {
            setTimeout(() => inputRef.current?.focus(), 100);
        }
    }, [isWizardOpen, wizardStep]);

    // Step 3 State
    const [notes, setNotes] = useState("");

    // Confirmation Modals
    const [deleteConfirmId, setDeleteConfirmId] = useState(null);
    const [transitConfirmData, setTransitConfirmData] = useState(null);

    const resetWizard = useCallback(() => {
        setWizardStep(1);
        setSelectedCarrier("");
        setAwbInput("");
        setScannedParcels([]);
        setScanError("");
        setScanSuccess("");
        setNotes("");
        setIsWizardOpen(false);
    }, []);

    const handleNextStep = () => {
        if (wizardStep === 1 && !selectedCarrier) return;
        if (wizardStep === 2 && scannedParcels.length === 0) return;
        setWizardStep((s) => s + 1);
    };

    const handleCreateDispatch = () => {
        const formData = new FormData();
        formData.append("intent", "create_dispatch");
        formData.append("carrierId", selectedCarrier);
        formData.append("notes", notes);
        scannedParcels.forEach((p) => {
            formData.append("parcelIds[]", p.id);
        });
        fetcher.submit(formData, { method: "post" });
        resetWizard();
    };

    const lastProcessedFetch = useRef(null);

    // Handle specific intent returns from the server action
    useEffect(() => {
        if (fetcher.state === "idle" && fetcher.data && fetcher.data.intent === "fetch_parcel") {
            // Prevent double execution on the exact same fetch response payload
            if (lastProcessedFetch.current === fetcher.data.timestamp) return;
            lastProcessedFetch.current = fetcher.data.timestamp;

            if (fetcher.data.error) {
                setScanError(fetcher.data.error);
            } else if (fetcher.data.parcel) {
                const parcel = fetcher.data.parcel;

                if (String(parcel.carrierId) !== String(selectedCarrier)) {
                    setScanError(`Parcel belongs to a different carrier (${parcel.carrierName}). Cannot add.`);
                } else if (parcel.dispatchStatus !== "pending") {
                    setScanError(`Parcel "${parcel.awbNumber}" is already dispatched.`);
                } else if (parcel.dispatchmentId) {
                    setScanError(`Parcel "${parcel.awbNumber}" is already in another dispatchment.`);
                } else {
                    setScannedParcels(prev => [...prev, parcel]);
                    setScanSuccess(`Added: ${parcel.awbNumber} (Order ${parcel.orderName})`);
                    setTimeout(() => setScanSuccess(""), 2000);
                }
            }
            setAwbInput("");
            setTimeout(() => inputRef.current?.focus(), 50);
        }
    }, [fetcher.state, fetcher.data, selectedCarrier]);

    const handleAwbSubmit = (e) => {
        if (e) {
            e.preventDefault();
            e.stopPropagation();
        }

        const awb = awbInput.trim();
        if (!awb) return;

        setScanError("");
        setScanSuccess("");

        // 1. Local validation FIRST (like the Next.js pattern)
        if (scannedParcels.some(p => p.awbNumber.toLowerCase() === awb.toLowerCase())) {
            setScanError(`This parcel (${awb}) has already been scanned.`);
            setAwbInput("");
            setTimeout(() => inputRef.current?.focus(), 50);
            return;
        }

        // 2. Fetch via fetcher
        const formData = new FormData();
        formData.append("intent", "fetch_parcel");
        formData.append("awbNumber", awb);
        fetcher.submit(formData, { method: "post" });
    };

    const removeScannedParcel = (id) => {
        setScannedParcels(prev => prev.filter(p => p.id !== id));
    };

    const carrierOptions = [
        { label: "Select Carrier", value: "" },
        ...activeCarriers.map(c => ({ label: c.name, value: c.id.toString() }))
    ];

    return (
        <Page
            title="Dispatches"
            primaryAction={{
                content: "Quick Dispatch",
                onAction: () => setIsWizardOpen(true)
            }}
        >
            <Layout>
                <Layout.Section>
                    <Card padding="0">
                        <IndexTable
                            resourceName={{ singular: "dispatch", plural: "dispatches" }}
                            itemCount={dispatches.length}
                            headings={[
                                { title: "ID" },
                                { title: "Carrier" },
                                { title: "Parcels" },
                                { title: "Transit Status" },
                                { title: "Notes" },
                                { title: "Created At" },
                                { title: "Actions" },
                            ]}
                            selectable={false}
                        >
                            {dispatches.map((dispatch) => (
                                <IndexTable.Row key={dispatch.id} id={dispatch.id}>
                                    <IndexTable.Cell><Text variant="bodyMd" fontWeight="bold">#{dispatch.id}</Text></IndexTable.Cell>
                                    <IndexTable.Cell>{dispatch.carrier.name}</IndexTable.Cell>
                                    <IndexTable.Cell>{dispatch._count.parcels}</IndexTable.Cell>
                                    <IndexTable.Cell>
                                        <Badge tone={dispatch.transitStatus === "sent" ? "success" : "info"}>
                                            {dispatch.transitStatus.toUpperCase()}
                                        </Badge>
                                    </IndexTable.Cell>
                                    <IndexTable.Cell>{dispatch.notes || "-"}</IndexTable.Cell>
                                    <IndexTable.Cell>{new Date(dispatch.createdAt).toLocaleString()}</IndexTable.Cell>
                                    <IndexTable.Cell>
                                        <InlineStack gap="200">
                                            <Button
                                                icon={dispatch.transitStatus === "pending" ? DeliveryIcon : CheckIcon}
                                                onClick={() => setTransitConfirmData({ id: dispatch.id, status: dispatch.transitStatus })}
                                                title="Toggle Transit Status"
                                                variant="plain"
                                                tone={dispatch.transitStatus === "pending" ? "success" : "base"}
                                            />
                                            <Button
                                                icon={DeleteIcon}
                                                tone="critical"
                                                onClick={() => setDeleteConfirmId(dispatch.id)}
                                                title="Delete Dispatch"
                                                variant="plain"
                                            />
                                        </InlineStack>
                                    </IndexTable.Cell>
                                </IndexTable.Row>
                            ))}
                        </IndexTable>
                    </Card>
                </Layout.Section>
            </Layout>

            {/* Quick Dispatch Wizard */}
            <Modal
                open={isWizardOpen}
                onClose={resetWizard}
                title={`Quick Dispatch - Step ${wizardStep} of 3`}
                primaryAction={{
                    content: wizardStep === 3 ? "Dispatch" : "Next",
                    onAction: wizardStep === 3 ? handleCreateDispatch : handleNextStep,
                    disabled: (wizardStep === 1 && !selectedCarrier) || (wizardStep === 2 && scannedParcels.length === 0)
                }}
                secondaryActions={[
                    {
                        content: "Cancel",
                        onAction: resetWizard
                    }
                ]}
            >
                <Modal.Section>
                    {wizardStep === 1 && (
                        <FormLayout>
                            <Select
                                label="Select Carrier"
                                options={carrierOptions}
                                value={selectedCarrier}
                                onChange={setSelectedCarrier}
                            />
                        </FormLayout>
                    )}

                    {wizardStep === 2 && (
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
                                    {scannedParcels.map(p => (
                                        <List.Item key={p.id}>
                                            <InlineStack align="space-between">
                                                <Text as="span">{p.awbNumber} - Order {p.orderName}</Text>
                                                <Button variant="plain" tone="critical" onClick={() => removeScannedParcel(p.id)}>Remove</Button>
                                            </InlineStack>
                                        </List.Item>
                                    ))}
                                </List>
                            ) : (
                                <Text color="subdued" as="span">No parcels scanned yet.</Text>
                            )}
                        </BlockStack>
                    )}

                    {wizardStep === 3 && (
                        <FormLayout>
                            <Text as="p" variant="bodyMd">
                                You are about to dispatch <strong>{scannedParcels.length}</strong> parcels via <strong>{activeCarriers.find(c => String(c.id) === selectedCarrier)?.name}</strong>.
                            </Text>
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

            {/* Delete Confirmation */}
            <Modal
                open={!!deleteConfirmId}
                onClose={() => setDeleteConfirmId(null)}
                title="Delete Dispatchment?"
                primaryAction={{
                    content: "Delete",
                    destructive: true,
                    onAction: () => {
                        const formData = new FormData();
                        formData.append("intent", "delete_dispatch");
                        formData.append("id", deleteConfirmId);
                        fetcher.submit(formData, { method: "post" });
                        setDeleteConfirmId(null);
                    }
                }}
                secondaryActions={[
                    {
                        content: "Cancel",
                        onAction: () => setDeleteConfirmId(null)
                    }
                ]}
            >
                <Modal.Section>
                    <Text as="p">
                        Are you sure you want to delete this dispatchment? All associated parcels will revert to 'pending' status.
                    </Text>
                </Modal.Section>
            </Modal>

            {/* Toggle Transit Status Confirmation */}
            <Modal
                open={!!transitConfirmData}
                onClose={() => setTransitConfirmData(null)}
                title="Change Transit Status?"
                primaryAction={{
                    content: "Confirm",
                    onAction: () => {
                        const formData = new FormData();
                        formData.append("intent", "toggle_transit_status");
                        formData.append("id", transitConfirmData.id);
                        formData.append("currentStatus", transitConfirmData.status);
                        fetcher.submit(formData, { method: "post" });
                        setTransitConfirmData(null);
                    }
                }}
                secondaryActions={[
                    {
                        content: "Cancel",
                        onAction: () => setTransitConfirmData(null)
                    }
                ]}
            >
                <Modal.Section>
                    <Text as="p">
                        Are you sure you want to change the transit status from <strong>{transitConfirmData?.status}</strong> to <strong>{transitConfirmData?.status === "pending" ? "sent" : "pending"}</strong>?
                    </Text>
                </Modal.Section>
            </Modal>
        </Page>
    );
}
