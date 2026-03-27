import { useState, useCallback } from "react";
import { json } from "@remix-run/node";
import {
    useLoaderData,
    useSubmit,
    useActionData,
    useNavigation,
} from "@remix-run/react";
import {
    Page,
    Layout,
    Card,
    BlockStack,
    Text,
    Badge,
    Grid,
    TextField,
    Button,
    List,
    InlineStack,
    Box,
    Modal,
    Select,
    FormLayout,
    Banner,
    Divider,
} from "@shopify/polaris";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";

function numberToWords(num) {
    const ones = ["", "ONE", "TWO", "THREE", "FOUR", "FIVE", "SIX", "SEVEN", "EIGHT", "NINE",
        "TEN", "ELEVEN", "TWELVE", "THIRTEEN", "FOURTEEN", "FIFTEEN", "SIXTEEN", "SEVENTEEN", "EIGHTEEN", "NINETEEN"];
    const tens = ["", "", "TWENTY", "THIRTY", "FORTY", "FIFTY", "SIXTY", "SEVENTY", "EIGHTY", "NINETY"];
    function convert(n) {
        if (n === 0) return "";
        if (n < 20) return ones[n];
        if (n < 100) return tens[Math.floor(n / 10)] + (n % 10 ? " " + ones[n % 10] : "");
        if (n < 1000) return ones[Math.floor(n / 100)] + " HUNDRED" + (n % 100 ? " AND " + convert(n % 100) : "");
        if (n < 100000) return convert(Math.floor(n / 1000)) + " THOUSAND" + (n % 1000 ? " " + convert(n % 1000) : "");
        return convert(Math.floor(n / 100000)) + " LAKH" + (n % 100000 ? " " + convert(n % 100000) : "");
    }
    return (convert(Math.round(num)) || "ZERO") + " ONLY";
}

export const loader = async ({ request, params }) => {
    const { admin } = await authenticate.admin(request);
    const orderId = `gid://shopify/Order/${params.id}`;

    const response = await admin.graphql(
        `#graphql
      query getOrder($id: ID!) {
        order(id: $id) {
          id
          name
          createdAt
          note
          tags
          displayFinancialStatus
          displayFulfillmentStatus
          totalPriceSet {
            shopMoney {
              amount
              currencyCode
            }
          }
          totalOutstandingSet {
            shopMoney {
              amount
              currencyCode
            }
          }
          customer {
            firstName
            lastName
            defaultEmailAddress { emailAddress }
            defaultPhoneNumber { phoneNumber }
          }
          shippingAddress {
            address1
            address2
            city
            province
            zip
            country
            phone
          }
          lineItems(first: 50) {
            edges {
              node {
                id
                title
                quantity
                originalTotalSet {
                  shopMoney {
                    amount
                    currencyCode
                  }
                }
              }
            }
          }
          fulfillmentOrders(first: 10) {
            edges {
              node {
                id
                status
                supportedActions {
                  action
                }
                lineItems(first: 50) {
                  edges {
                    node {
                      id
                      totalQuantity
                      remainingQuantity
                      lineItem {
                        title
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }`,
        {
            variables: {
                id: orderId,
            },
        }
    );

    const shopResponse = await admin.graphql(`#graphql
      query {
        shop {
          name
          billingAddress {
            address1
            address2
            city
            province
            zip
            country
            phone
          }
        }
      }
    `);
    const shopJson = await shopResponse.json();
    const shop = shopJson.data.shop;

    const responseJson = await response.json();
    const order = responseJson.data.order;

    const packages = await prisma.package.findMany({ orderBy: { name: "asc" } });
    const carriers = await prisma.carrier.findMany({
        where: { isActive: true },
        orderBy: { name: "asc" },
    });

    const parcels = await prisma.parcel.findMany({
        where: { orderId },
        orderBy: { createdAt: "desc" },
    });

    return json({ order, packages, carriers, parcels, shop });
};

export const action = async ({ request, params }) => {
    const { admin } = await authenticate.admin(request);
    const formData = await request.formData();
    const actionType = formData.get("actionType");
    const orderId = `gid://shopify/Order/${params.id}`;

    let errors = [];

    if (actionType === "updateNote") {
        const note = formData.get("note");
        const response = await admin.graphql(
            `#graphql
      mutation orderUpdate($input: OrderInput!) {
        orderUpdate(input: $input) {
          order {
            id
            note
          }
          userErrors {
            field
            message
          }
        }
      }`,
            {
                variables: {
                    input: {
                        id: orderId,
                        note: note,
                    },
                },
            }
        );
        const result = await response.json();
        if (result.data?.orderUpdate?.userErrors?.length > 0) {
            errors = result.data.orderUpdate.userErrors;
        }
    } else if (actionType === "addTag") {
        const tags = formData.get("tags").split(",");
        const response = await admin.graphql(
            `#graphql
      mutation tagsAdd($id: ID!, $tags: [String!]!) {
        tagsAdd(id: $id, tags: $tags) {
          userErrors {
            field
            message
          }
        }
      }`,
            {
                variables: {
                    id: orderId,
                    tags: tags,
                },
            }
        );
        const result = await response.json();
        if (result.data?.tagsAdd?.userErrors?.length > 0) {
            errors = result.data.tagsAdd.userErrors;
        }
    } else if (actionType === "removeTag") {
        const tags = formData.get("tags").split(",");
        const response = await admin.graphql(
            `#graphql
      mutation tagsRemove($id: ID!, $tags: [String!]!) {
        tagsRemove(id: $id, tags: $tags) {
          userErrors {
            field
            message
          }
        }
      }`,
            {
                variables: {
                    id: orderId,
                    tags: tags,
                },
            }
        );
        const result = await response.json();
        if (result.data?.tagsRemove?.userErrors?.length > 0) {
            errors = result.data.tagsRemove.userErrors;
        }
    } else if (actionType === "fulfill") {
        const fulfillmentOrderId = formData.get("fulfillmentOrderId");
        const orderName = formData.get("orderName") || "";

        // Extract line item quantities correctly.
        const lineItems = [];
        for (const [key, value] of formData.entries()) {
            if (key.startsWith("qty_") && value) {
                const quantity = parseInt(value, 10);
                if (quantity > 0) {
                    lineItems.push({
                        id: key.replace("qty_", ""),
                        quantity: quantity,
                    });
                }
            }
        }

        const awbNumber = formData.get("awbNumber");
        const carrierIdStr = formData.get("carrierId");
        const carrierName = formData.get("carrierName");

        const parcelLength = parseFloat(formData.get("parcelLength")) || 0;
        const parcelWidth = parseFloat(formData.get("parcelWidth")) || 0;
        const parcelHeight = parseFloat(formData.get("parcelHeight")) || 0;
        const parcelWeight = parseFloat(formData.get("parcelWeight")) || 0;
        const parcelValueOfRepayment = formData.get("parcelValueOfRepayment")?.toString() || null;

        let trackingUrl = formData.get("trackingUrl") || "";
        if (trackingUrl && awbNumber) {
            trackingUrl = trackingUrl.replace("{awb_number}", awbNumber);
        }

        const fulfillmentPayload = {
            lineItemsByFulfillmentOrder: [
                {
                    fulfillmentOrderId: fulfillmentOrderId,
                    ...(lineItems.length > 0
                        ? { fulfillmentOrderLineItems: lineItems }
                        : {}),
                },
            ],
            notifyCustomer: true,
        };

        if (awbNumber) {
            fulfillmentPayload.trackingInfo = {
                number: awbNumber,
                company: carrierName,
                url: trackingUrl,
            };
        }

        const response = await admin.graphql(
            `#graphql
      mutation fulfillmentCreateV2($fulfillment: FulfillmentV2Input!) {
        fulfillmentCreateV2(fulfillment: $fulfillment) {
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
            {
                variables: {
                    fulfillment: fulfillmentPayload,
                },
            }
        );
        const result = await response.json();

        if (result.data?.fulfillmentCreateV2?.userErrors?.length > 0) {
            errors = result.data.fulfillmentCreateV2.userErrors;
        } else {
            const newFulfillmentId = result.data?.fulfillmentCreateV2?.fulfillment?.id;
            // Save Parcel
            if (newFulfillmentId) {
                await prisma.parcel.create({
                    data: {
                        orderId: orderId,
                        orderName: orderName,
                        fulfillmentId: newFulfillmentId,
                        carrierId: carrierIdStr ? parseInt(carrierIdStr, 10) : null,
                        carrierName: carrierName || "Custom",
                        awbNumber: awbNumber || "",
                        length: parcelLength,
                        width: parcelWidth,
                        height: parcelHeight,
                        weight: parcelWeight,
                        valueOfRepayment: parcelValueOfRepayment,
                        dispatchStatus: "pending",
                    },
                });
            }
        }
    } else if (actionType === "markPaid") {
        const response = await admin.graphql(
            `#graphql
      mutation orderMarkAsPaid($input: OrderMarkAsPaidInput!) {
        orderMarkAsPaid(input: $input) {
          order {
            id
            displayFinancialStatus
          }
          userErrors {
            field
            message
          }
        }
      }`,
            {
                variables: {
                    input: {
                        id: orderId,
                    },
                },
            }
        );
        const result = await response.json();
        if (result.data?.orderMarkAsPaid?.userErrors?.length > 0) {
            errors = result.data.orderMarkAsPaid.userErrors;
        }
    } else if (actionType === "deleteParcel") {
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
                // Only block on errors that aren't "already cancelled"
                const realErrors = cancelErrors.filter(
                    (e) => !e.message.toLowerCase().includes("already cancelled") &&
                        !e.message.toLowerCase().includes("cannot cancel")
                );
                if (realErrors.length > 0) {
                    errors = realErrors;
                }
            }
            // Delete parcel from DB regardless (fulfillment may already be cancelled)
            if (errors.length === 0) {
                await prisma.parcel.delete({ where: { id: parcelId } });
                return json({ errors, deleted: true });
            }
        }
    }

    return json({ errors, deleted: false });
};

export default function OrderDetails() {
    const { order, packages, carriers, parcels, shop } = useLoaderData();
    const actionData = useActionData();
    const submit = useSubmit();
    const navigation = useNavigation();

    const [note, setNote] = useState(order?.note || "");
    const [newTag, setNewTag] = useState("");

    // Delete parcel confirmation modal
    const [deleteModalOpen, setDeleteModalOpen] = useState(false);
    const [parcelToDelete, setParcelToDelete] = useState(null);

    const openDeleteModal = useCallback((parcel) => {
        setParcelToDelete(parcel);
        setDeleteModalOpen(true);
    }, []);

    const closeDeleteModal = useCallback(() => {
        setDeleteModalOpen(false);
        setParcelToDelete(null);
    }, []);

    const handleDeleteParcel = useCallback(() => {
        if (!parcelToDelete) return;
        submit(
            { actionType: "deleteParcel", parcelId: parcelToDelete.id.toString() },
            { method: "post" }
        );
        closeDeleteModal();
    }, [parcelToDelete, submit, closeDeleteModal]);

    // Wizard State
    const [isWizardOpen, setIsWizardOpen] = useState(false);
    const [wizardStep, setWizardStep] = useState(1);
    const [selectedFulfillmentOrderId, setSelectedFulfillmentOrderId] = useState(null);
    const [fulfillmentQuantities, setFulfillmentQuantities] = useState({});

    const [selectedCarrier, setSelectedCarrier] = useState("");
    const [selectedPackage, setSelectedPackage] = useState("");
    const [awbNumber, setAwbNumber] = useState("");
    const [parcelLength, setParcelLength] = useState("");
    const [parcelWidth, setParcelWidth] = useState("");
    const [parcelHeight, setParcelHeight] = useState("");
    const [parcelWeight, setParcelWeight] = useState("");
    const [parcelValueOfRepayment, setParcelValueOfRepayment] = useState("");

    const [shippingAddress, setShippingAddress] = useState({
        address1: "",
        address2: "",
        city: "",
        province: "",
        zip: "",
        country: "",
    });

    const isSubmitting = navigation.state === "submitting";

    const carrierOptions = [
        { label: "Select Carrier", value: "" },
        ...carriers.map((c) => ({ label: c.name, value: c.id.toString() })),
    ];

    const packageOptions = [
        { label: "Select Package Profile", value: "" },
        ...packages.map((p) => ({ label: p.name, value: p.id.toString() })),
        { label: "Custom Package", value: "custom" },
    ];

    const handleUpdateNote = useCallback(() => {
        submit({ actionType: "updateNote", note }, { method: "post" });
    }, [note, submit]);

    const handleAddTag = useCallback(() => {
        if (!newTag.trim()) return;
        submit(
            { actionType: "addTag", tags: newTag.trim() },
            { method: "post" }
        );
        setNewTag("");
    }, [newTag, submit]);

    const handleRemoveTag = useCallback(
        (tag) => {
            submit({ actionType: "removeTag", tags: tag }, { method: "post" });
        },
        [submit]
    );

    const handleMarkPaid = useCallback(() => {
        submit({ actionType: "markPaid" }, { method: "post" });
    }, [submit]);

    // Wizard Handlers
    const openWizard = useCallback((fulfillmentOrderId, lineItemsEdges) => {
        setSelectedFulfillmentOrderId(fulfillmentOrderId);
        setWizardStep(1);

        // Pre-fill maximum quantities
        const initialQtys = {};
        lineItemsEdges.forEach(({ node }) => {
            initialQtys[node.id] = node.remainingQuantity;
        });
        setFulfillmentQuantities(initialQtys);

        // Reset inputs
        setSelectedCarrier("");
        setSelectedPackage("");
        setAwbNumber("");
        setParcelLength("");
        setParcelWidth("");
        setParcelHeight("");
        setParcelWeight("");
        setParcelValueOfRepayment("");

        if (order?.shippingAddress) {
            setShippingAddress({
                address1: order.shippingAddress.address1 || "",
                address2: order.shippingAddress.address2 || "",
                city: order.shippingAddress.city || "",
                province: order.shippingAddress.province || "",
                zip: order.shippingAddress.zip || "",
                country: order.shippingAddress.country || "",
            });
        }
        setIsWizardOpen(true);
    }, [order]);

    const closeWizard = useCallback(() => {
        setIsWizardOpen(false);
    }, []);

    const handleQuantityChange = useCallback((lineItemId, value, max) => {
        let parsed = parseInt(value, 10) || 0;
        if (parsed < 0) parsed = 0;
        if (parsed > max) parsed = max;
        setFulfillmentQuantities((prev) => ({
            ...prev,
            [lineItemId]: parsed,
        }));
    }, []);

    const handlePackageChange = useCallback((val) => {
        setSelectedPackage(val);
        const pkg = packages.find((p) => p.id.toString() === val);
        if (pkg) {
            setParcelLength(pkg.length.toString());
            setParcelWidth(pkg.width.toString());
            setParcelHeight(pkg.height.toString());
            setParcelWeight(pkg.weight.toString());
            setParcelValueOfRepayment(pkg.valueOfRepayment || "");
        } else {
            setParcelLength("");
            setParcelWidth("");
            setParcelHeight("");
            setParcelWeight("");
            setParcelValueOfRepayment("");
        }
    }, [packages]);

    const handleFulfillSubmit = useCallback(() => {
        const formData = { actionType: "fulfill", fulfillmentOrderId: selectedFulfillmentOrderId };
        formData.orderName = order?.name || "";

        // Quantities
        Object.entries(fulfillmentQuantities).forEach(([id, qty]) => {
            if (qty !== undefined) {
                formData[`qty_${id}`] = qty;
            }
        });

        // Carrier
        let cName = "";
        let cTrackingUrl = "";
        let cId = "";
        if (selectedCarrier) {
            const c = carriers.find((c) => c.id.toString() === selectedCarrier);
            if (c) {
                cName = c.name;
                cTrackingUrl = c.trackingUrl;
                cId = c.id.toString();
            }
        }

        formData.awbNumber = awbNumber;
        formData.carrierId = cId;
        formData.carrierName = cName;
        formData.trackingUrl = cTrackingUrl;
        formData.parcelLength = parcelLength;
        formData.parcelWidth = parcelWidth;
        formData.parcelHeight = parcelHeight;
        formData.parcelWeight = parcelWeight;
        formData.parcelValueOfRepayment = parcelValueOfRepayment;

        submit(formData, { method: "post" });
        closeWizard();
    }, [submit, selectedFulfillmentOrderId, fulfillmentQuantities, selectedCarrier, carriers, awbNumber, parcelLength, parcelWidth, parcelHeight, parcelWeight, closeWizard, order]);

    const handlePrintLabel = useCallback((parcel) => {
        const outstandingAmount = parseFloat(order.totalOutstandingSet?.shopMoney?.amount || 0);
        const isCOD = outstandingAmount > 0;
        const currency = order.totalPriceSet.shopMoney.currencyCode;
        const addr = order.shippingAddress || {};
        const cName = order.customer
            ? `${order.customer.firstName || ""} ${order.customer.lastName || ""}`.trim()
            : "";
        const customerPhone = addr.phone || order.customer?.defaultPhoneNumber?.phoneNumber || "";
        const storeAddr = shop?.billingAddress || {};
        const orderDate = new Date(order.createdAt).toLocaleDateString("en-IN");
        const products = order.lineItems.edges.map(({ node }) => node);
        const fmt = (amt) => new Intl.NumberFormat("en-IN", { style: "currency", currency }).format(amt);

        const html = `<!DOCTYPE html>
<html><head>
<meta charset="utf-8">
<title>Label - ${order.name}</title>
<style>
@page { size: 105mm 148mm; margin: 3mm; }
* { box-sizing: border-box; margin: 0; padding: 0; }
body { font-family: Arial, sans-serif; font-size: 8.5pt; width: 99mm; }
.label { border: 1.5pt solid #000; padding: 3mm; width: 99mm; min-height: 140mm; }
.header { background: #000; color: #fff; text-align: center; padding: 2mm 1mm; font-size: 10pt; font-weight: bold; margin-bottom: 2mm; }
.cod-box { border: 2pt solid #000; padding: 2mm; margin-bottom: 2mm; text-align: center; }
.cod-amount { font-size: 13pt; font-weight: bold; margin: 1mm 0; }
.cod-words { font-size: 7pt; }
.row { display: flex; gap: 2mm; }
.half { flex: 1; }
.sec-title { font-weight: bold; border-bottom: 0.5pt solid #000; margin-bottom: 1mm; font-size: 7.5pt; }
.addr-name { font-weight: bold; font-size: 9.5pt; }
.divider { border-top: 0.5pt solid #000; margin: 2mm 0; }
.awb-box { text-align: center; border: 1pt solid #000; padding: 2mm; margin-bottom: 2mm; }
.awb { font-size: 13pt; font-weight: bold; letter-spacing: 1pt; }
.meta { display: flex; justify-content: space-between; font-size: 7.5pt; margin-bottom: 1mm; flex-wrap: wrap; gap: 0.5mm; }
.bnpl-box { border: 1pt solid #000; padding: 2mm; margin-bottom: 2mm; text-align: center; }
.bnpl-main { font-weight: bold; font-size: 9pt; }
.bnpl-sub { font-size: 7.5pt; margin-top: 0.5mm; }
table { width: 100%; border-collapse: collapse; font-size: 7.5pt; }
th { background: #eee; border: 0.5pt solid #000; padding: 1mm; text-align: left; }
td { border: 0.5pt solid #000; padding: 1mm; }
.footer { display: flex; justify-content: space-between; font-size: 7.5pt; margin-top: 1mm; flex-wrap: wrap; gap: 0.5mm; }
@media print { body { -webkit-print-color-adjust: exact; print-color-adjust: exact; } }
</style></head>
<body><div class="label">
<div class="header">${shop?.name || "SHIPPING LABEL"}</div>
<div class="bnpl-box">
  <div class="bnpl-main">BOOKED UNDER BNPL${isCOD ? " (SP-COD)" : ""}</div>
  <div class="bnpl-sub">BHUJ HPO - 370001(GUJ-K)</div>
  <div class="bnpl-sub">Biller ID: 0000058749</div>
</div>
${isCOD ? `
<div class="cod-box">
  <div style="font-weight:bold;font-size:8pt;">COD COLLECT AMOUNT</div>
  <div class="cod-amount">${fmt(outstandingAmount)}</div>
  <div class="cod-words">Words: ${numberToWords(outstandingAmount)}</div>
</div>` : ""}
<div class="row">
  <div class="half">
    <div class="sec-title">To,</div>
    <div class="addr-name">${cName}</div>
    ${addr.address1 ? `<div>${addr.address1}</div>` : ""}
    ${addr.address2 ? `<div>${addr.address2}</div>` : ""}
    <div>${[addr.city, addr.province, addr.zip].filter(Boolean).join(", ")}</div>
    <div>${addr.country || ""}</div>
    ${customerPhone ? `<div>Ph: ${customerPhone}</div>` : ""}
  </div>
  <div class="half">
    <div class="sec-title">From,</div>
    <div class="addr-name">${shop?.name || ""}</div>
    ${storeAddr.address1 ? `<div>${storeAddr.address1}</div>` : ""}
    ${storeAddr.address2 ? `<div>${storeAddr.address2}</div>` : ""}
    <div>${[storeAddr.city, storeAddr.province, storeAddr.zip].filter(Boolean).join(", ")}</div>
    ${storeAddr.phone ? `<div>Mo: ${storeAddr.phone}</div>` : ""}
  </div>
</div>
<div class="divider"></div>
<div class="awb-box"><div class="awb">${parcel.awbNumber || "—"}</div></div>
<div class="meta">
  <span><b>Pay Mode:</b> ${isCOD ? "COD" : "PREPAID"}</span>
  <span><b>Order:</b> ${order.name}</span>
  <span><b>Date:</b> ${orderDate}</span>
  <span><b>Carrier:</b> ${parcel.carrierName}</span>
</div>
<div class="divider"></div>
<table>
  <thead><tr><th>Product</th><th>Qty</th><th>Price</th></tr></thead>
  <tbody>
    ${products.map(p => `<tr><td>${p.title}</td><td>${p.quantity}</td><td>${fmt(p.originalTotalSet.shopMoney.amount)}</td></tr>`).join("")}
  </tbody>
</table>
<div class="footer">
  <span>Total: ${fmt(order.totalPriceSet.shopMoney.amount)}</span>
  <span>${parcel.length}x${parcel.width}x${parcel.height}cm · ${parcel.weight}kg</span>
</div>
</div>
<script>window.onload=function(){window.print();};</script>
</body></html>`;

        const w = window.open("", "_blank", "width=500,height=720");
        if (w) { w.document.write(html); w.document.close(); }
    }, [order, shop]);

    if (!order) {
        return (
            <Page>
                <Text>Order not found</Text>
            </Page>
        );
    }

    const customerName = order.customer
        ? `${order.customer.firstName || ""} ${order.customer.lastName || ""}`.trim()
        : "No customer details";

    const price = new Intl.NumberFormat("en-US", {
        style: "currency",
        currency: order.totalPriceSet.shopMoney.currencyCode,
    }).format(order.totalPriceSet.shopMoney.amount);

    const activeFulfillmentOrderNode = order.fulfillmentOrders?.edges?.find(
        (e) => e.node.id === selectedFulfillmentOrderId
    )?.node;

    return (
        <Page
            backAction={{ content: "Orders", url: "/app" }}
            title={`Order ${order.name}`}
            subtitle={new Date(order.createdAt).toLocaleString()}
            compactTitle
            titleMetadata={
                <InlineStack gap="200" align="center">
                    <Badge
                        tone={
                            order.displayFinancialStatus === "PAID"
                                ? "success"
                                : order.displayFinancialStatus === "PENDING"
                                    ? "warning"
                                    : "new"
                        }
                    >
                        {order.displayFinancialStatus || "UNKNOWN"}
                    </Badge>
                    <Badge
                        tone={
                            order.displayFulfillmentStatus === "FULFILLED"
                                ? "success"
                                : order.displayFulfillmentStatus === "UNFULFILLED"
                                    ? "attention"
                                    : "new"
                        }
                    >
                        {order.displayFulfillmentStatus || "UNFULFILLED"}
                    </Badge>
                </InlineStack>
            }
        >
            <Layout>
                <Layout.Section>
                    <BlockStack gap="500">
                        {/* Action Errors */}
                        {actionData?.errors?.length > 0 && (
                            <Card background="bg-surface-critical-active">
                                <Text tone="critical" as="p">
                                    There was an error processing your request:
                                </Text>
                                <ul>
                                    {actionData.errors.map((error, index) => (
                                        <li key={index}>
                                            <Text tone="critical" as="span">
                                                {error.message}
                                            </Text>
                                        </li>
                                    ))}
                                </ul>
                            </Card>
                        )}

                        {/* Line Items */}
                        <Card>
                            <BlockStack gap="400">
                                <Text variant="headingMd" as="h2">
                                    Items
                                </Text>
                                <List>
                                    {order.lineItems.edges.map(({ node }) => (
                                        <List.Item key={node.id}>
                                            <InlineStack align="space-between">
                                                <Text as="span">{node.quantity} x {node.title}</Text>
                                                <Text as="span">
                                                    {new Intl.NumberFormat("en-US", {
                                                        style: "currency",
                                                        currency: node.originalTotalSet.shopMoney.currencyCode,
                                                    }).format(node.originalTotalSet.shopMoney.amount)}
                                                </Text>
                                            </InlineStack>
                                        </List.Item>
                                    ))}
                                </List>
                                <Box paddingBlockStart="400" borderBlockStart="025" borderColor="border">
                                    <InlineStack align="space-between">
                                        <Text variant="headingMd" as="h3">Total</Text>
                                        <Text variant="headingMd" as="h3">{price}</Text>
                                    </InlineStack>
                                </Box>
                            </BlockStack>
                        </Card>

                        {/* Parcels (from DB) */}
                        {parcels && parcels.length > 0 && (
                            <Card>
                                <BlockStack gap="400">
                                    <Text variant="headingMd" as="h2">
                                        Parcels
                                    </Text>
                                    {parcels.map((parcel, idx) => (
                                        <Box key={parcel.id}>
                                            {idx > 0 && <Box paddingBlockEnd="200"><Divider /></Box>}
                                            <BlockStack gap="200">
                                                <InlineStack align="space-between" blockAlign="center">
                                                    <BlockStack gap="100">
                                                        <InlineStack gap="200" align="start">
                                                            <Text as="span" fontWeight="bold">{parcel.carrierName}</Text>
                                                            <Badge tone={parcel.dispatchStatus === "dispatched" ? "info" : parcel.dispatchStatus === "delivered" ? "success" : parcel.dispatchStatus === "cancelled" ? "critical" : "warning"}>
                                                                {parcel.dispatchStatus}
                                                            </Badge>
                                                        </InlineStack>
                                                        <Text as="span" tone="subdued">AWB: {parcel.awbNumber || "—"}</Text>
                                                        <Text as="span" tone="subdued">
                                                            {parcel.length}x{parcel.width}x{parcel.height} cm · {parcel.weight} kg
                                                        </Text>
                                                        {parcel.dispatchmentId && (
                                                            <Text as="span" tone="caution">Linked to Dispatch #{parcel.dispatchmentId}</Text>
                                                        )}
                                                    </BlockStack>
                                                    <InlineStack gap="200">
                                                        <Button
                                                            size="micro"
                                                            onClick={() => handlePrintLabel(parcel)}
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
                                                </InlineStack>
                                            </BlockStack>
                                        </Box>
                                    ))}
                                </BlockStack>
                            </Card>
                        )}

                        {/* Fulfillments */}
                        {order.fulfillmentOrders && order.fulfillmentOrders.edges.length > 0 && (
                            <Card>
                                <BlockStack gap="400">
                                    <Text variant="headingMd" as="h2">
                                        Fulfillments
                                    </Text>
                                    {order.fulfillmentOrders.edges.map(({ node }) => {
                                        const canFulfill = node.supportedActions.some(
                                            (action) => action.action === "CREATE_FULFILLMENT"
                                        );
                                        return (
                                            <Box key={node.id} paddingBlockEnd="200" borderBlockEnd="025" borderColor="border">
                                                <BlockStack gap="200">
                                                    <InlineStack align="space-between">
                                                        <Text as="span" variant="bodyMd" fontWeight="bold">
                                                            Status: {node.status}
                                                        </Text>
                                                        {canFulfill && (
                                                            <Button
                                                                size="micro"
                                                                variant="primary"
                                                                onClick={() => openWizard(node.id, node.lineItems.edges)}
                                                                loading={isSubmitting}
                                                            >
                                                                Create fulfillment
                                                            </Button>
                                                        )}
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
                                                </BlockStack>
                                            </Box>
                                        );
                                    })}
                                </BlockStack>
                            </Card>
                        )}
                    </BlockStack>
                </Layout.Section>

                <Layout.Section variant="oneThird">
                    <BlockStack gap="500">
                        {/* Status Actions */}
                        <Card>
                            <BlockStack gap="400">
                                <Text variant="headingMd" as="h2">
                                    Order Actions
                                </Text>
                                {order.displayFinancialStatus === "PENDING" && (
                                    <Button
                                        onClick={handleMarkPaid}
                                        loading={isSubmitting}
                                        fullWidth
                                    >
                                        Mark as Paid
                                    </Button>
                                )}
                            </BlockStack>
                        </Card>

                        {/* Customer Details */}
                        <Card>
                            <BlockStack gap="200">
                                <Text variant="headingMd" as="h2">
                                    Customer
                                </Text>
                                <Text as="p">{customerName}</Text>
                                {order.customer?.email && (
                                    <Text as="p" tone="subdued">
                                        {order.customer.email}
                                    </Text>
                                )}
                            </BlockStack>
                        </Card>

                        {/* Notes */}
                        <Card>
                            <BlockStack gap="400">
                                <Text variant="headingMd" as="h2">
                                    Notes
                                </Text>
                                <TextField
                                    value={note}
                                    onChange={setNote}
                                    multiline={4}
                                    autoComplete="off"
                                />
                                <Button onClick={handleUpdateNote} loading={isSubmitting}>
                                    Save Note
                                </Button>
                            </BlockStack>
                        </Card>

                        {/* Tags */}
                        <Card>
                            <BlockStack gap="400">
                                <Text variant="headingMd" as="h2">
                                    Tags
                                </Text>
                                {order.tags && order.tags.length > 0 ? (
                                    <InlineStack gap="200">
                                        {order.tags.map((tag) => (
                                            <Badge key={tag} tone="info">
                                                <InlineStack gap="100" align="center">
                                                    <Text as="span">{tag}</Text>
                                                    <Button
                                                        size="micro"
                                                        variant="plain"
                                                        onClick={() => handleRemoveTag(tag)}
                                                        loading={isSubmitting}
                                                    >
                                                        x
                                                    </Button>
                                                </InlineStack>
                                            </Badge>
                                        ))}
                                    </InlineStack>
                                ) : (
                                    <Text as="p" tone="subdued">
                                        No tags
                                    </Text>
                                )}
                                <InlineStack gap="200">
                                    <TextField
                                        value={newTag}
                                        onChange={setNewTag}
                                        autoComplete="off"
                                        placeholder="Add a tag"
                                    />
                                    <Button onClick={handleAddTag} loading={isSubmitting}>
                                        Add
                                    </Button>
                                </InlineStack>
                            </BlockStack>
                        </Card>
                    </BlockStack>
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
                }}
                secondaryActions={[{ content: "Cancel", onAction: closeDeleteModal }]}
            >
                <Modal.Section>
                    <BlockStack gap="200">
                        <Text as="p">
                            Are you sure you want to delete this parcel?
                        </Text>
                        {parcelToDelete && (
                            <Text as="p" tone="subdued">
                                AWB: <strong>{parcelToDelete.awbNumber || "—"}</strong> · Carrier: {parcelToDelete.carrierName}
                            </Text>
                        )}
                        {parcelToDelete?.dispatchmentId && (
                            <Banner tone="warning">
                                This parcel is linked to Dispatch #{parcelToDelete.dispatchmentId} and <strong>cannot be deleted</strong> until it is removed from the dispatch.
                            </Banner>
                        )}
                        {!parcelToDelete?.dispatchmentId && (
                            <Banner tone="critical">
                                This will also <strong>cancel</strong> the associated Shopify fulfillment. This action cannot be undone.
                            </Banner>
                        )}
                    </BlockStack>
                </Modal.Section>
            </Modal>

            {/* FULFILLMENT WIZARD MODAL */}
            <Modal
                open={isWizardOpen}
                onClose={closeWizard}
                title={`Create Fulfillment - Step ${wizardStep} of 3`}
                primaryAction={{
                    content: wizardStep === 3 ? "Complete Fulfillment" : "Next",
                    onAction: wizardStep === 3 ? handleFulfillSubmit : () => setWizardStep(wizardStep + 1),
                    loading: isSubmitting,
                    disabled: wizardStep === 2 && (!awbNumber || !selectedCarrier || !selectedPackage),
                }}
                secondaryActions={[
                    wizardStep > 1
                        ? {
                            content: "Back",
                            onAction: () => setWizardStep(wizardStep - 1),
                        }
                        : {
                            content: "Cancel",
                            onAction: closeWizard,
                        },
                ]}
                large
            >
                <Modal.Section>
                    {wizardStep === 1 && activeFulfillmentOrderNode && (
                        <BlockStack gap="400">
                            <Text variant="headingMd" as="h3">Select Items to Fulfill</Text>
                            <List>
                                {activeFulfillmentOrderNode.lineItems.edges.map(({ node: fiNode }) => (
                                    <List.Item key={fiNode.id}>
                                        <InlineStack align="space-between" blockAlign="center" gap="400">
                                            <Text as="span">{fiNode.lineItem.title}</Text>
                                            {fiNode.remainingQuantity > 0 ? (
                                                <InlineStack gap="200" align="end" blockAlign="center">
                                                    <Text tone="subdued" as="span">Max: {fiNode.remainingQuantity}</Text>
                                                    <TextField
                                                        type="number"
                                                        min={0}
                                                        max={fiNode.remainingQuantity}
                                                        value={
                                                            fulfillmentQuantities[fiNode.id] !== undefined
                                                                ? fulfillmentQuantities[fiNode.id].toString()
                                                                : ""
                                                        }
                                                        onChange={(value) => handleQuantityChange(fiNode.id, value, fiNode.remainingQuantity)}
                                                        autoComplete="off"
                                                    />
                                                </InlineStack>
                                            ) : (
                                                <Text as="span" tone="subdued">Fully Fulfilled</Text>
                                            )}
                                        </InlineStack>
                                    </List.Item>
                                ))}
                            </List>
                        </BlockStack>
                    )}

                    {wizardStep === 2 && (
                        <BlockStack gap="400">
                            <Text variant="headingMd" as="h3">Parcel Details</Text>
                            <FormLayout>
                                <Select
                                    label="Shipping Carrier"
                                    options={carrierOptions}
                                    value={selectedCarrier}
                                    onChange={setSelectedCarrier}
                                />
                                <TextField
                                    label="AWB Tracking Number"
                                    value={awbNumber}
                                    onChange={setAwbNumber}
                                    autoComplete="off"
                                    requiredIndicator
                                />

                                <Select
                                    label="Package / Dimensions"
                                    options={packageOptions}
                                    value={selectedPackage}
                                    onChange={handlePackageChange}
                                />

                                <FormLayout.Group>
                                    <TextField
                                        label="Length (cm)"
                                        type="number"
                                        value={parcelLength}
                                        onChange={setParcelLength}
                                        autoComplete="off"
                                        disabled={selectedPackage !== "custom" && selectedPackage !== ""}
                                    />
                                    <TextField
                                        label="Width (cm)"
                                        type="number"
                                        value={parcelWidth}
                                        onChange={setParcelWidth}
                                        autoComplete="off"
                                        disabled={selectedPackage !== "custom" && selectedPackage !== ""}
                                    />
                                </FormLayout.Group>
                                <FormLayout.Group>
                                    <TextField
                                        label="Height (cm)"
                                        type="number"
                                        value={parcelHeight}
                                        onChange={setParcelHeight}
                                        autoComplete="off"
                                        disabled={selectedPackage !== "custom" && selectedPackage !== ""}
                                    />
                                    <TextField
                                        label="Weight (kg)"
                                        type="number"
                                        value={parcelWeight}
                                        onChange={setParcelWeight}
                                        autoComplete="off"
                                        disabled={selectedPackage !== "custom" && selectedPackage !== ""}
                                    />
                                </FormLayout.Group>
                                <TextField
                                    label="Value Of Repayment"
                                    type="text"
                                    value={parcelValueOfRepayment}
                                    onChange={setParcelValueOfRepayment}
                                    autoComplete="off"
                                    disabled={selectedPackage !== "custom" && selectedPackage !== ""}
                                />
                            </FormLayout>
                        </BlockStack>
                    )}

                    {wizardStep === 3 && (
                        <BlockStack gap="400">
                            <Text variant="headingMd" as="h3">Shipping Address (Editable)</Text>
                            <FormLayout>
                                <TextField
                                    label="Address 1"
                                    value={shippingAddress.address1}
                                    onChange={(v) => setShippingAddress((prev) => ({ ...prev, address1: v }))}
                                    autoComplete="off"
                                />
                                <TextField
                                    label="Address 2"
                                    value={shippingAddress.address2}
                                    onChange={(v) => setShippingAddress((prev) => ({ ...prev, address2: v }))}
                                    autoComplete="off"
                                />
                                <FormLayout.Group>
                                    <TextField
                                        label="City"
                                        value={shippingAddress.city}
                                        onChange={(v) => setShippingAddress((prev) => ({ ...prev, city: v }))}
                                        autoComplete="off"
                                    />
                                    <TextField
                                        label="Province / State"
                                        value={shippingAddress.province}
                                        onChange={(v) => setShippingAddress((prev) => ({ ...prev, province: v }))}
                                        autoComplete="off"
                                    />
                                </FormLayout.Group>
                                <FormLayout.Group>
                                    <TextField
                                        label="Zip / Postal Code"
                                        value={shippingAddress.zip}
                                        onChange={(v) => setShippingAddress((prev) => ({ ...prev, zip: v }))}
                                        autoComplete="off"
                                    />
                                    <TextField
                                        label="Country"
                                        value={shippingAddress.country}
                                        onChange={(v) => setShippingAddress((prev) => ({ ...prev, country: v }))}
                                        autoComplete="off"
                                    />
                                </FormLayout.Group>
                            </FormLayout>
                        </BlockStack>
                    )}
                </Modal.Section>
            </Modal>
        </Page>
    );
}
