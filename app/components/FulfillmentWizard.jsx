import { useState, useCallback, useEffect } from "react";
import { useFetcher } from "@remix-run/react";
import {
    Modal, BlockStack, InlineStack, Text, Button, TextField, Select,
    FormLayout, Banner, Box, Divider, List, Spinner, Icon,
} from "@shopify/polaris";
import { CheckCircleIcon } from "@shopify/polaris-icons";
import { printLabel } from "../utils/printLabel";

/**
 * Self-contained Fulfillment Wizard Modal (4-step).
 *
 * Props:
 *   open        {boolean}   whether the modal is visible
 *   onClose     {function}  called when modal closes
 *   orderId     {string}    Shopify Order GID (e.g. "gid://shopify/Order/123")
 *   orderName   {string}    display name (e.g. "#1001")
 *   carriers    {array}     carrier records from the DB
 *   packages    {array}     package records from the DB
 *   onFulfilled {function?} optional callback fired after successful fulfillment
 */
export default function FulfillmentWizard({ open, onClose, orderId, orderName, carriers = [], packages = [], onFulfilled }) {
    const fetcher = useFetcher();
    const labelFetcher = useFetcher();

    // Wizard state
    const [step, setStep] = useState(1);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState("");
    const [orderData, setOrderData] = useState(null);

    // Step 1
    const [selectedFulfillmentOrderId, setSelectedFulfillmentOrderId] = useState(null);
    const [quantities, setQuantities] = useState({});

    // Step 2
    const [selectedCarrier, setSelectedCarrier] = useState("");
    const [selectedPackage, setSelectedPackage] = useState("");
    const [awbNumber, setAwbNumber] = useState("");
    const [parcelLength, setParcelLength] = useState("");
    const [parcelWidth, setParcelWidth] = useState("");
    const [parcelHeight, setParcelHeight] = useState("");
    const [parcelWeight, setParcelWeight] = useState("");
    const [parcelVOR, setParcelVOR] = useState("");

    // Step 3
    const [shippingAddress, setShippingAddress] = useState({
        address1: "", address2: "", city: "", province: "", zip: "", country: "",
    });

    // Step 4 (Print Label)
    const [createdParcel, setCreatedParcel] = useState(null);
    const [labelData, setLabelData] = useState(null);
    const [labelLoading, setLabelLoading] = useState(false);
    const [labelPrinted, setLabelPrinted] = useState(false);

    // Reset everything when modal opens
    useEffect(() => {
        if (open && orderId) {
            setStep(1);
            setLoading(true);
            setError("");
            setOrderData(null);
            setSelectedFulfillmentOrderId(null);
            setQuantities({});
            setSelectedCarrier("");
            setSelectedPackage("");
            setAwbNumber("");
            setParcelLength("");
            setParcelWidth("");
            setParcelHeight("");
            setParcelWeight("");
            setParcelVOR("");
            setShippingAddress({ address1: "", address2: "", city: "", province: "", zip: "", country: "" });
            setCreatedParcel(null);
            setLabelData(null);
            setLabelLoading(false);
            setLabelPrinted(false);

            const fd = new FormData();
            fd.append("intent", "fetchOrderData");
            fd.append("orderId", orderId);
            fetcher.submit(fd, { method: "post", action: "/api/fulfillment" });
        }
    }, [open, orderId]);

    // Process fetcher responses
    useEffect(() => {
        if (fetcher.state !== "idle" || !fetcher.data) return;

        if (fetcher.data.intent === "fetchOrderData") {
            setLoading(false);
            if (fetcher.data.orderData) {
                setOrderData(fetcher.data.orderData);
                const addr = fetcher.data.orderData.shippingAddress;
                if (addr) {
                    setShippingAddress({
                        address1: addr.address1 || "",
                        address2: addr.address2 || "",
                        city: addr.city || "",
                        province: addr.province || "",
                        zip: addr.zip || "",
                        country: addr.country || "",
                    });
                }
                // Auto-select if only one fulfillable order
                const fulfillable = fetcher.data.orderData.fulfillmentOrders.edges
                    .filter(({ node }) => node.supportedActions.some(a => a.action === "CREATE_FULFILLMENT"));
                if (fulfillable.length === 1) {
                    const node = fulfillable[0].node;
                    setSelectedFulfillmentOrderId(node.id);
                    const qtys = {};
                    node.lineItems.edges.forEach(({ node: li }) => { qtys[li.id] = li.remainingQuantity; });
                    setQuantities(qtys);
                }
            } else {
                setError("Failed to load order data.");
            }
        }

        if (fetcher.data.intent === "fulfill") {
            if (fetcher.data.success) {
                // Move to step 4 and fetch label data
                const parcel = fetcher.data.parcel;
                setCreatedParcel(parcel);
                setStep(4);
                setLabelLoading(true);
                onFulfilled?.();

                // Fetch order + shop data for the label
                const fd = new FormData();
                fd.append("intent", "getLabelData");
                fd.append("orderId", orderId);
                labelFetcher.submit(fd, { method: "post", action: "/api/print-label" });
            } else if (fetcher.data.errors) {
                setError(fetcher.data.errors.map(e => e.message).join(", "));
            }
        }
    }, [fetcher.state, fetcher.data]);

    // Process label data response
    useEffect(() => {
        if (labelFetcher.state !== "idle" || !labelFetcher.data) return;

        if (labelFetcher.data.intent === "getLabelData") {
            setLabelLoading(false);
            if (labelFetcher.data.order && labelFetcher.data.shop) {
                setLabelData({ order: labelFetcher.data.order, shop: labelFetcher.data.shop });
                // Auto-print
                if (createdParcel) {
                    printLabel({
                        order: labelFetcher.data.order,
                        shop: labelFetcher.data.shop,
                        parcel: createdParcel,
                    });
                    setLabelPrinted(true);
                }
            }
        }
    }, [labelFetcher.state, labelFetcher.data, createdParcel]);

    const handlePackageChange = useCallback((val) => {
        setSelectedPackage(val);
        const pkg = packages.find(p => p.id.toString() === val);
        if (pkg) {
            setParcelLength(pkg.length.toString());
            setParcelWidth(pkg.width.toString());
            setParcelHeight(pkg.height.toString());
            setParcelWeight(pkg.weight.toString());
            setParcelVOR(pkg.valueOfRepayment || "");
        } else {
            setParcelLength(""); setParcelWidth(""); setParcelHeight(""); setParcelWeight(""); setParcelVOR("");
        }
    }, [packages]);

    const handleSubmit = useCallback(() => {
        const fd = new FormData();
        fd.append("intent", "fulfill");
        fd.append("fulfillmentOrderId", selectedFulfillmentOrderId);
        fd.append("orderName", orderName || orderData?.name || "");
        fd.append("orderId", orderId || "");

        Object.entries(quantities).forEach(([id, qty]) => {
            if (qty !== undefined) fd.append(`qty_${id}`, qty);
        });

        let cName = "", cTrackingUrl = "", cId = "";
        if (selectedCarrier) {
            const c = carriers.find(c => c.id.toString() === selectedCarrier);
            if (c) { cName = c.name; cTrackingUrl = c.trackingUrl; cId = c.id.toString(); }
        }

        fd.append("awbNumber", awbNumber);
        fd.append("carrierId", cId);
        fd.append("carrierName", cName);
        fd.append("trackingUrl", cTrackingUrl);
        fd.append("parcelLength", parcelLength);
        fd.append("parcelWidth", parcelWidth);
        fd.append("parcelHeight", parcelHeight);
        fd.append("parcelWeight", parcelWeight);
        fd.append("parcelValueOfRepayment", parcelVOR);

        fetcher.submit(fd, { method: "post", action: "/api/fulfillment" });
    }, [selectedFulfillmentOrderId, orderName, orderId, orderData, quantities, selectedCarrier, awbNumber, parcelLength, parcelWidth, parcelHeight, parcelWeight, parcelVOR, carriers, fetcher]);

    const handlePrintAgain = useCallback(() => {
        if (labelData && createdParcel) {
            printLabel({ order: labelData.order, shop: labelData.shop, parcel: createdParcel });
        }
    }, [labelData, createdParcel]);

    const carrierOptions = [
        { label: "Select Carrier", value: "" },
        ...carriers.map(c => ({ label: c.name, value: c.id.toString() })),
    ];

    const packageOptions = [
        { label: "Select Package Profile", value: "" },
        ...packages.map(p => ({ label: p.name, value: p.id.toString() })),
        { label: "Custom Package", value: "custom" },
    ];

    const dimDisabled = selectedPackage !== "custom" && selectedPackage !== "";

    // Build modal actions based on step
    let primaryAction, secondaryActions;
    if (step === 4) {
        primaryAction = { content: "Done", onAction: onClose };
        secondaryActions = labelData && createdParcel
            ? [{ content: "Print Again", onAction: handlePrintAgain }]
            : undefined;
    } else if (!loading) {
        primaryAction = {
            content: step === 3 ? "Complete Fulfillment" : "Next",
            onAction: step === 3 ? handleSubmit : () => setStep(s => s + 1),
            loading: fetcher.state !== "idle",
            disabled:
                (step === 1 && !selectedFulfillmentOrderId) ||
                (step === 2 && (!awbNumber || !selectedCarrier || !selectedPackage)),
        };
        secondaryActions = [
            step > 1
                ? { content: "Back", onAction: () => setStep(s => s - 1) }
                : { content: "Cancel", onAction: onClose },
        ];
    }

    const stepLabel = step <= 3 ? `Step ${step} of 3` : "Complete";

    return (
        <Modal
            open={open}
            onClose={onClose}
            title={loading ? "Loading Order Data..." : `Create Fulfillment - ${orderName || ""} - ${stepLabel}`}
            primaryAction={primaryAction}
            secondaryActions={secondaryActions}
            large
        >
            <Modal.Section>
                {loading && (
                    <BlockStack gap="400" inlineAlign="center">
                        <Spinner size="large" />
                        <Text as="p" alignment="center">Fetching fulfillment data...</Text>
                    </BlockStack>
                )}

                {error && <Banner tone="critical">{error}</Banner>}

                {/* STEP 1: Select fulfillment order + quantities */}
                {!loading && !error && step === 1 && orderData && (() => {
                    const fulfillable = orderData.fulfillmentOrders.edges
                        .filter(({ node }) => node.supportedActions.some(a => a.action === "CREATE_FULFILLMENT"));
                    return (
                        <BlockStack gap="400">
                            <Text variant="headingMd" as="h3">Select Fulfillment Order</Text>
                            {fulfillable.map(({ node }) => (
                                <Box key={node.id} padding="300" borderWidth="025" borderColor="border" borderRadius="200"
                                    background={selectedFulfillmentOrderId === node.id ? "bg-surface-selected" : "bg-surface"}
                                >
                                    <BlockStack gap="200">
                                        <InlineStack align="space-between">
                                            <Text as="span" fontWeight="bold">Status: {node.status}</Text>
                                            <Button
                                                size="micro"
                                                variant={selectedFulfillmentOrderId === node.id ? "primary" : "secondary"}
                                                onClick={() => {
                                                    setSelectedFulfillmentOrderId(node.id);
                                                    const qtys = {};
                                                    node.lineItems.edges.forEach(({ node: li }) => { qtys[li.id] = li.remainingQuantity; });
                                                    setQuantities(qtys);
                                                }}
                                            >
                                                {selectedFulfillmentOrderId === node.id ? "Selected" : "Select"}
                                            </Button>
                                        </InlineStack>
                                        <List>
                                            {node.lineItems.edges.map(({ node: fiNode }) => (
                                                <List.Item key={fiNode.id}>
                                                    <InlineStack align="space-between" blockAlign="center" gap="400">
                                                        <Text as="span">{fiNode.lineItem.title}</Text>
                                                        <Text tone="subdued" as="span">{fiNode.remainingQuantity} remaining</Text>
                                                    </InlineStack>
                                                </List.Item>
                                            ))}
                                        </List>
                                        {selectedFulfillmentOrderId === node.id && (
                                            <BlockStack gap="200">
                                                <Divider />
                                                <Text variant="headingSm" as="h4">Quantities to Fulfill</Text>
                                                {node.lineItems.edges.map(({ node: fiNode }) => (
                                                    <InlineStack key={fiNode.id} align="space-between" blockAlign="center" gap="400">
                                                        <Text as="span">{fiNode.lineItem.title}</Text>
                                                        <InlineStack gap="200" align="end" blockAlign="center">
                                                            <Text tone="subdued" as="span">Max: {fiNode.remainingQuantity}</Text>
                                                            <div style={{ width: "80px" }}>
                                                                <TextField
                                                                    type="number"
                                                                    min={0}
                                                                    max={fiNode.remainingQuantity}
                                                                    value={quantities[fiNode.id]?.toString() || "0"}
                                                                    onChange={(v) => {
                                                                        let parsed = parseInt(v, 10) || 0;
                                                                        if (parsed < 0) parsed = 0;
                                                                        if (parsed > fiNode.remainingQuantity) parsed = fiNode.remainingQuantity;
                                                                        setQuantities(prev => ({ ...prev, [fiNode.id]: parsed }));
                                                                    }}
                                                                    autoComplete="off"
                                                                />
                                                            </div>
                                                        </InlineStack>
                                                    </InlineStack>
                                                ))}
                                            </BlockStack>
                                        )}
                                    </BlockStack>
                                </Box>
                            ))}
                            {fulfillable.length === 0 && (
                                <Banner tone="warning">No fulfillment orders available for this order.</Banner>
                            )}
                        </BlockStack>
                    );
                })()}

                {/* STEP 2: Parcel details */}
                {!loading && step === 2 && (
                    <BlockStack gap="400">
                        <Text variant="headingMd" as="h3">Parcel Details</Text>
                        <FormLayout>
                            <Select label="Shipping Carrier" options={carrierOptions} value={selectedCarrier} onChange={setSelectedCarrier} />
                            <TextField label="AWB Tracking Number" value={awbNumber} onChange={setAwbNumber} autoComplete="off" requiredIndicator />
                            <Select label="Package / Dimensions" options={packageOptions} value={selectedPackage} onChange={handlePackageChange} />
                            <FormLayout.Group>
                                <TextField label="Length (cm)" type="number" value={parcelLength} onChange={setParcelLength} autoComplete="off" disabled={dimDisabled} />
                                <TextField label="Width (cm)" type="number" value={parcelWidth} onChange={setParcelWidth} autoComplete="off" disabled={dimDisabled} />
                            </FormLayout.Group>
                            <FormLayout.Group>
                                <TextField label="Height (cm)" type="number" value={parcelHeight} onChange={setParcelHeight} autoComplete="off" disabled={dimDisabled} />
                                <TextField label="Weight (kg)" type="number" value={parcelWeight} onChange={setParcelWeight} autoComplete="off" disabled={dimDisabled} />
                            </FormLayout.Group>
                            <TextField label="Value Of Repayment" type="text" value={parcelVOR} onChange={setParcelVOR} autoComplete="off" disabled={dimDisabled} />
                        </FormLayout>
                    </BlockStack>
                )}

                {/* STEP 3: Shipping address */}
                {!loading && step === 3 && (
                    <BlockStack gap="400">
                        <Text variant="headingMd" as="h3">Shipping Address (Editable)</Text>
                        <FormLayout>
                            <TextField label="Address 1" value={shippingAddress.address1} onChange={(v) => setShippingAddress(p => ({ ...p, address1: v }))} autoComplete="off" />
                            <TextField label="Address 2" value={shippingAddress.address2} onChange={(v) => setShippingAddress(p => ({ ...p, address2: v }))} autoComplete="off" />
                            <FormLayout.Group>
                                <TextField label="City" value={shippingAddress.city} onChange={(v) => setShippingAddress(p => ({ ...p, city: v }))} autoComplete="off" />
                                <TextField label="Province / State" value={shippingAddress.province} onChange={(v) => setShippingAddress(p => ({ ...p, province: v }))} autoComplete="off" />
                            </FormLayout.Group>
                            <FormLayout.Group>
                                <TextField label="Zip / Postal Code" value={shippingAddress.zip} onChange={(v) => setShippingAddress(p => ({ ...p, zip: v }))} autoComplete="off" />
                                <TextField label="Country" value={shippingAddress.country} onChange={(v) => setShippingAddress(p => ({ ...p, country: v }))} autoComplete="off" />
                            </FormLayout.Group>
                        </FormLayout>
                    </BlockStack>
                )}

                {/* STEP 4: Print Label */}
                {step === 4 && (
                    <BlockStack gap="400" inlineAlign="center">
                        <Box paddingBlockStart="400" paddingBlockEnd="200">
                            <BlockStack gap="300" inlineAlign="center">
                                <div style={{ color: "#008060" }}>
                                    <Icon source={CheckCircleIcon} tone="success" />
                                </div>
                                <Text variant="headingLg" as="h2" alignment="center">
                                    Fulfillment Created Successfully!
                                </Text>
                            </BlockStack>
                        </Box>

                        {createdParcel && (
                            <Box padding="300" borderWidth="025" borderColor="border" borderRadius="200" background="bg-surface-secondary">
                                <BlockStack gap="200">
                                    <InlineStack align="space-between">
                                        <Text as="span" fontWeight="bold">Carrier</Text>
                                        <Text as="span">{createdParcel.carrierName}</Text>
                                    </InlineStack>
                                    <InlineStack align="space-between">
                                        <Text as="span" fontWeight="bold">AWB Number</Text>
                                        <Text as="span">{createdParcel.awbNumber || "—"}</Text>
                                    </InlineStack>
                                    <InlineStack align="space-between">
                                        <Text as="span" fontWeight="bold">Dimensions</Text>
                                        <Text as="span">{createdParcel.length}×{createdParcel.width}×{createdParcel.height} cm</Text>
                                    </InlineStack>
                                    <InlineStack align="space-between">
                                        <Text as="span" fontWeight="bold">Weight</Text>
                                        <Text as="span">{createdParcel.weight} kg</Text>
                                    </InlineStack>
                                </BlockStack>
                            </Box>
                        )}

                        {labelLoading && (
                            <BlockStack gap="200" inlineAlign="center">
                                <Spinner size="small" />
                                <Text as="p" tone="subdued" alignment="center">Preparing shipping label...</Text>
                            </BlockStack>
                        )}

                        {labelPrinted && (
                            <Banner tone="success">
                                Shipping label has been sent to the print dialog. Click "Print Again" if needed.
                            </Banner>
                        )}

                        {!labelLoading && !labelData && !labelPrinted && (
                            <Banner tone="warning">
                                Could not load label data. You can print the label later from the order detail page.
                            </Banner>
                        )}
                    </BlockStack>
                )}
            </Modal.Section>
        </Modal>
    );
}
