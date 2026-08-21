import { json, unstable_composeUploadHandlers, unstable_createFileUploadHandler, unstable_createMemoryUploadHandler, unstable_parseMultipartFormData } from "@remix-run/node";
import { useLoaderData, useNavigate, useSubmit, useNavigation, useFetcher, useSearchParams } from "@remix-run/react";
import {
  Page, Layout, Card, Text, Button, BlockStack, InlineStack, Badge,
  Divider, Box, Modal, FormLayout, Select, TextField, Banner, List, Icon, Spinner, Autocomplete
} from "@shopify/polaris";
import { DeliveryIcon, ReceiptIcon, CheckCircleIcon, DeleteIcon, LinkIcon, SearchIcon } from "@shopify/polaris-icons";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { useState, useEffect, useCallback } from "react";
import { printLabel } from "../utils/printLabel";
import { printInvoice } from "../utils/printInvoice";
import { INDIAN_STATES } from "../utils/indianStates";

// --- LOADER ---
export const loader = async ({ request, params }) => {
  await authenticate.admin(request);
  const orderId = parseInt(params.id, 10);

  const order = await prisma.customOrder.findUnique({ where: { id: orderId } });
  if (!order) {
    throw new Response("Not Found", { status: 404 });
  }

  const [carriers, packages, addons, parcels, transactions, invoice] = await Promise.all([
    prisma.carrier.findMany({ where: { isActive: true }, orderBy: { name: "asc" } }),
    prisma.package.findMany({ orderBy: { name: "asc" } }),
    prisma.addonProduct.findMany({ where: { isActive: true, stock: { gt: 0 } }, orderBy: { name: "asc" } }),
    prisma.parcel.findMany({ where: { orderId: `custom-${orderId}` }, include: { addons: { include: { addon: true } } } }),
    prisma.transactionHistory.findMany({ where: { orderName: order.orderName }, orderBy: { createdAt: "desc" } }),
    prisma.invoice.findUnique({ where: { orderId: `custom-${orderId}` } })
  ]);

  return json({ order, carriers, packages, addons, parcels, transactions, invoice });
};

// --- ACTION ---
export const action = async ({ request, params }) => {
  await authenticate.admin(request);

  const contentType = request.headers.get("content-type") || "";
  let formData;
  if (contentType.includes("multipart/form-data")) {
    const uploadHandler = unstable_composeUploadHandlers(
      unstable_createFileUploadHandler({
        maxPartSize: 10_000_000,
        file: ({ filename }) => `${Date.now()}-${filename.replace(/[^a-zA-Z0-9.-]/g, "_")}`,
        directory: "public/uploads"
      }),
      unstable_createMemoryUploadHandler()
    );
    formData = await unstable_parseMultipartFormData(request, uploadHandler);
  } else {
    formData = await request.formData();
  }

  const intent = formData.get("intent");
  const orderId = parseInt(params.id, 10);

  if (intent === "addPayment") {
    const amount = parseFloat(formData.get("amount"));
    const mode = formData.get("mode");

    const order = await prisma.customOrder.findUnique({ where: { id: orderId } });
    if (!order) return json({ error: "Order not found" }, { status: 404 });

    if (mode === "Manual") {
      const file = formData.get("document");
      const documentUrl = file && file.name ? `/uploads/${file.name}` : null;

      await prisma.transactionHistory.create({
        data: {
          orderName: order.orderName,
          amountPaid: amount,
          currency: "INR",
          mode: "Manual",
          status: "SUCCESS",
          documentUrl: documentUrl
        }
      });

      const totalAmount = parseFloat(order.totalAmount || 0);
      const newPartial = parseFloat(order.partialPaymentAmount || 0) + amount;

      let newStatus = "PARTIALLY PAID";
      if (newPartial >= totalAmount || totalAmount === 0 || Math.abs(newPartial - totalAmount) < 0.01) {
        newStatus = "FULLY PAID";
      }

      await prisma.customOrder.update({
        where: { id: orderId },
        data: { partialPaymentAmount: newPartial, paymentStatus: newStatus }
      });

      return json({ success: true, intent: "addPayment" });
    } else if (mode === "Razorpay") {
      const phone = formData.get("phone");
      const email = formData.get("email");

      const [keyIdRow, keySecretRow] = await Promise.all([
        prisma.setting.findUnique({ where: { key: "razorpay_key_id" } }),
        prisma.setting.findUnique({ where: { key: "razorpay_key_secret" } }),
      ]);

      if (!keyIdRow?.value || !keySecretRow?.value) {
        return json({ error: "Razorpay keys not found in settings" }, { status: 400 });
      }

      const credentials = Buffer.from(`${keyIdRow.value}:${keySecretRow.value}`).toString("base64");

      const resp = await fetch("https://api.razorpay.com/v1/payment_links", {
        method: "POST",
        headers: { Authorization: `Basic ${credentials}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          amount: Math.round(amount * 100),
          currency: "INR",
          description: `Payment for order ${order.orderName}`,
          reference_id: `${order.orderName}_${Date.now()}`,
          customer: { name: order.customerName, email: email, contact: phone },
          notify: { sms: !!phone, email: !!email }
        })
      });
      const data = await resp.json();
      if (!resp.ok) {
        return json({ error: data.error?.description || "Failed to generate link" }, { status: 400 });
      }

      await prisma.transactionHistory.create({
        data: {
          orderName: order.orderName,
          amountPaid: amount,
          currency: "INR",
          mode: "Razorpay",
          status: "PENDING",
          paymentLinkId: data.id,
          documentUrl: data.short_url
        }
      });

      return json({ success: true, intent: "addPayment" });
    }
  }

  if (intent === "fulfill") {
    const awbNumber = formData.get("awbNumber");
    const carrierId = parseInt(formData.get("carrierId"), 10);
    const carrierName = formData.get("carrierName");
    const parcelLength = parseFloat(formData.get("parcelLength"));
    const parcelWidth = parseFloat(formData.get("parcelWidth"));
    const parcelHeight = parseFloat(formData.get("parcelHeight"));
    const parcelWeight = parseFloat(formData.get("parcelWeight"));
    const parcelValueOfRepayment = formData.get("parcelValueOfRepayment") || "";
    const addonPayload = JSON.parse(formData.get("addonPayload") || "[]");

    const order = await prisma.customOrder.findUnique({ where: { id: orderId } });
    if (!order) return json({ error: "Order not found" }, { status: 404 });

    const parcel = await prisma.$transaction(async (tx) => {
      let invoice = await tx.invoice.findUnique({
        where: { orderId: `custom-${orderId}` }
      });

      if (!invoice) {
        const prefixSetting = await tx.setting.findUnique({ where: { key: "invoice_prefix" } });
        const serialSetting = await tx.setting.findUnique({ where: { key: "invoice_start_serial" } });

        const prefix = prefixSetting?.value !== undefined ? prefixSetting.value : "INV-";
        const serialStr = serialSetting?.value !== undefined ? serialSetting.value : "1000";
        const serialNum = parseInt(serialStr, 10) || 1000;

        const invoiceNumber = `${prefix}${serialNum}`;

        invoice = await tx.invoice.create({
          data: {
            orderId: `custom-${orderId}`,
            invoiceNumber
          }
        });

        await tx.setting.upsert({
          where: { key: "invoice_start_serial" },
          update: { value: (serialNum + 1).toString() },
          create: { key: "invoice_start_serial", value: (serialNum + 1).toString() }
        });
      }

      const newParcel = await tx.parcel.create({
        data: {
          orderId: `custom-${orderId}`,
          orderName: order.orderName,
          fulfillmentId: "custom",
          carrierId, carrierName, awbNumber,
          length: parcelLength, width: parcelWidth, height: parcelHeight, weight: parcelWeight,
          valueOfRepayment: parcelValueOfRepayment,
          addons: {
            create: addonPayload.map(a => ({ addonId: parseInt(a.id, 10), quantity: a.quantity }))
          }
        }
      });

      // Update stock for addons
      for (const a of addonPayload) {
        await tx.addonProduct.update({
          where: { id: parseInt(a.id, 10) },
          data: { stock: { decrement: a.quantity } }
        });
      }

      return newParcel;
    });

    // Mark custom order as fulfilled
    await prisma.customOrder.update({
      where: { id: orderId },
      data: { fulfillmentStatus: "FULFILLED" }
    });

    return json({ success: true, parcel });
  }

  if (intent === "update") {
    const order = await prisma.customOrder.findUnique({ where: { id: orderId } });
    if (!order) return json({ error: "Order not found" }, { status: 404 });

    const customerName = formData.get("customerName");
    const customerEmail = formData.get("customerEmail");
    const customerPhone = formData.get("customerPhone");
    const address1 = formData.get("address1");
    const address2 = formData.get("address2");
    const city = formData.get("city");
    const province = formData.get("province");
    const zip = formData.get("zip");
    const country = formData.get("country");
    const orderType = formData.get("orderType");

    const data = {
      customerName, customerEmail, customerPhone, phone: customerPhone,
      address1, address2, city, province, zip, country, orderType,
    };

    // Products/discount only editable while no payment has been recorded yet.
    const hasPayment = order.partialPaymentAmount > 0 || order.paymentStatus !== "UNPAID";
    if (!hasPayment) {
      const itemsJson = formData.get("items");
      if (itemsJson !== null) {
        const discountType = formData.get("discountType");
        const discountValue = parseFloat(formData.get("discountValue") || "0");
        const items = JSON.parse(itemsJson);
        let productTotal = 0;
        items.forEach(i => { productTotal += parseFloat(i.price || 0) * parseInt(i.quantity || 1, 10); });
        let totalAmount = productTotal;
        if (discountType === "fixed") totalAmount -= discountValue;
        else if (discountType === "percent") totalAmount -= (totalAmount * discountValue) / 100;
        if (totalAmount < 0) totalAmount = 0;

        data.items = itemsJson;
        data.discountType = discountType !== "none" ? discountType : null;
        data.discountValue = discountValue;
        data.totalAmount = totalAmount;
      }
    }

    await prisma.customOrder.update({ where: { id: orderId }, data });
    return json({ success: true, intent: "update" });
  }

  if (intent === "delete") {
    await prisma.customOrder.delete({ where: { id: orderId } });
    return json({ success: true });
  }

  return json({ error: "Invalid intent" }, { status: 400 });
};

// --- COMPONENT ---
export default function CustomOrderDetail() {
  const { order, carriers, packages, addons, parcels, transactions, invoice } = useLoaderData();
  const navigate = useNavigate();
  const submit = useSubmit();
  const [searchParams] = useSearchParams();
  const items = order.items ? JSON.parse(order.items) : [];

  const [fulfillWizardOpen, setFulfillWizardOpen] = useState(false);
  const [deleteModalOpen, setDeleteModalOpen] = useState(false);
  const [editModalOpen, setEditModalOpen] = useState(false);
  const hasPayment = order.partialPaymentAmount > 0 || order.paymentStatus !== "UNPAID";

  // Add Payment Modal State
  const [addPaymentOpen, setAddPaymentOpen] = useState(false);
  const [paymentType, setPaymentType] = useState("full");
  const [paymentAmount, setPaymentAmount] = useState("");
  const [paymentMode, setPaymentMode] = useState("Razorpay");
  const [paymentPhone, setPaymentPhone] = useState(order.customerPhone || "");
  const [paymentEmail, setPaymentEmail] = useState(order.customerEmail || "");
  const [paymentFile, setPaymentFile] = useState(null);

  const remainingDue = Math.max(0, order.totalAmount - (order.partialPaymentAmount || 0));
  const totalCODCollected = parcels.reduce((sum, p) => {
    const val = parseFloat(p.valueOfRepayment);
    return sum + (isNaN(val) ? 0 : val);
  }, 0);
  const remainingCOD = Math.max(0, remainingDue - totalCODCollected);

  useEffect(() => {
    if (addPaymentOpen && paymentType === "full") {
      setPaymentAmount(remainingDue.toString());
    } else if (addPaymentOpen && paymentType === "partial") {
      setPaymentAmount("");
    }
  }, [addPaymentOpen, paymentType, remainingDue]);

  useEffect(() => {
    if (searchParams.get("action") === "payment" && order.paymentStatus !== "FULLY PAID") {
      setAddPaymentOpen(true);
    }
  }, [searchParams, order.paymentStatus]);

  const addPaymentFetcher = useFetcher();

  const handleAddPayment = () => {
    const fd = new FormData();
    fd.append("intent", "addPayment");
    fd.append("amount", paymentAmount);
    fd.append("mode", paymentMode);
    if (paymentMode === "Manual" && paymentFile) {
      fd.append("document", paymentFile);
    } else if (paymentMode === "Razorpay") {
      fd.append("phone", paymentPhone);
      fd.append("email", paymentEmail);
    }
    addPaymentFetcher.submit(fd, { method: "post", encType: paymentMode === "Manual" ? "multipart/form-data" : "application/x-www-form-urlencoded" });
  };

  useEffect(() => {
    if (addPaymentFetcher.data?.success && addPaymentFetcher.data?.intent === "addPayment") {
      setAddPaymentOpen(false);
      setPaymentFile(null);
      setPaymentAmount("");
      setPaymentType("full");
      shopify.toast.show(`Payment logged explicitly!`);
    }
  }, [addPaymentFetcher.data]);

  // Print label status
  const labelFetcher = useFetcher();
  const [printingParcelId, setPrintingParcelId] = useState(null);

  const handlePrintLabel = useCallback((parcel) => {
    setPrintingParcelId(parcel.id);
    const fd = new FormData();
    fd.append("intent", "getLabelData");
    fd.append("orderId", `custom-${order.id}`);
    labelFetcher.submit(fd, { method: "post", action: "/api/print-label" });
  }, [labelFetcher, order.id]);

  useEffect(() => {
    if (labelFetcher.state !== "idle" || !labelFetcher.data) return;
    if (labelFetcher.data.intent === "getLabelData" && printingParcelId) {
      if (labelFetcher.data.order && labelFetcher.data.shop) {
        const fullParcel = labelFetcher.data.parcels?.find(p => p.id === printingParcelId);
        printLabel({
          order: labelFetcher.data.order,
          shop: labelFetcher.data.shop,
          parcel: fullParcel,
          printSettings: labelFetcher.data.printSettings,
        });
      }
      setPrintingParcelId(null);
    }
  }, [labelFetcher.state, labelFetcher.data, printingParcelId]);

  const productTotal = items.reduce((acc, item) => acc + item.price * item.quantity, 0);

  let paymentTone = "warning";
  if (order.paymentStatus === "FULLY PAID") paymentTone = "success";
  else if (order.paymentStatus === "PARTIALLY PAID") paymentTone = "info";

  return (
    <Page
      title={order.orderName}
      breadcrumbs={[{ content: "Custom Orders", onAction: () => navigate("/app/custom-orders") }]}
      primaryAction={
        order.fulfillmentStatus !== "FULFILLED" && parcels.length === 0 ? {
          content: "Fulfill Order",
          onAction: () => setFulfillWizardOpen(true)
        } : undefined
      }
      secondaryActions={[
        { content: "Edit", onAction: () => setEditModalOpen(true) },
        { content: "Print Invoice", onAction: () => window.open(`/api/custom-invoice/${order.id}`, '_blank'), disabled: !invoice },
        ...(order.paymentStatus !== "FULLY PAID" ? [{ content: "Add Payment", onAction: () => setAddPaymentOpen(true) }] : []),
        { content: "Delete", destructive: true, onAction: () => setDeleteModalOpen(true) }
      ]}
    >
      <Layout>
        <Layout.Section>
          <BlockStack gap="400">
            <Card>
              <BlockStack gap="400">
                <Text variant="headingMd" as="h2">Details</Text>
                <InlineStack align="space-between">
                  <Text as="span">Date</Text>
                  <Text as="span">{new Date(order.createdAt).toLocaleString()}</Text>
                </InlineStack>
                <InlineStack align="space-between">
                  <Text as="span">Order Type</Text>
                  <Badge tone="info">{order.orderType}</Badge>
                </InlineStack>
                <InlineStack align="space-between">
                  <Text as="span">Payment Status</Text>
                  <Badge tone={paymentTone}>{order.paymentStatus}</Badge>
                </InlineStack>
                <InlineStack align="space-between">
                  <Text as="span">Fulfillment Status</Text>
                  <Badge tone={order.fulfillmentStatus === "FULFILLED" ? "success" : "new"}>{order.fulfillmentStatus}</Badge>
                </InlineStack>
              </BlockStack>
            </Card>

            <Card>
              <BlockStack gap="400">
                <Text variant="headingMd" as="h2">Products</Text>
                <BlockStack gap="200">
                  {items.map((item, i) => (
                    <Box key={i} paddingBlockEnd="200" borderBlockEndWidth={i < items.length - 1 ? "025" : undefined} borderColor="border">
                      <InlineStack align="space-between">
                        <Text as="span" fontWeight="semibold">{item.quantity} x {item.title}</Text>
                        <Text as="span">₹{(item.price * item.quantity).toFixed(2)}</Text>
                      </InlineStack>
                    </Box>
                  ))}
                </BlockStack>
                <Divider />
                <BlockStack gap="200">
                  <InlineStack align="space-between">
                    <Text tone="subdued" as="span">Subtotal</Text>
                    <Text tone="subdued" as="span">₹{productTotal.toFixed(2)}</Text>
                  </InlineStack>
                  {order.discountType && order.discountType !== "none" && (
                    <InlineStack align="space-between">
                      <Text tone="subdued" as="span">Discount ({order.discountType === "percent" ? `${order.discountValue}%` : `₹${order.discountValue} Fixed`})</Text>
                      <Text tone="critical" as="span">- ₹{(productTotal - order.totalAmount).toFixed(2)}</Text>
                    </InlineStack>
                  )}
                  <InlineStack align="space-between">
                    <Text variant="headingSm" as="h3">Total Amount</Text>
                    <Text variant="headingSm" as="h3">₹{order.totalAmount.toFixed(2)}</Text>
                  </InlineStack>
                </BlockStack>
              </BlockStack>
            </Card>

            {transactions && transactions.length > 0 && (
              <Card>
                <BlockStack gap="400">
                  <Text variant="headingMd" as="h2">Transaction History</Text>
                  <List type="bullet">
                    {transactions.map(txn => (
                      <List.Item key={txn.id}>
                        <BlockStack gap="100">
                          <InlineStack gap="200" blockAlign="center">
                            <Text as="span" fontWeight="bold">₹{txn.amountPaid.toFixed(2)}</Text>
                            <Badge tone={txn.status === "SUCCESS" ? "success" : "warning"}>{txn.status}</Badge>
                            <Text as="span" tone="subdued">
                              {new Date(txn.createdAt).toLocaleString()}
                            </Text>
                            <Badge tone="info">{txn.mode}</Badge>
                          </InlineStack>

                          {txn.status === "PENDING" && txn.paymentLinkId && (
                            <InlineStack gap="200" blockAlign="center">
                              <Text as="p" tone="subdued" variant="bodySm">Link ID: {txn.paymentLinkId}</Text>
                              <Button variant="plain" onClick={() => {
                                shopify.toast.show("URL Copied to clipboard");
                                navigator.clipboard.writeText(txn.documentUrl || `https://rzp.io/i/${txn.paymentLinkId}`);
                              }}>
                                Copy Link URL
                              </Button>
                            </InlineStack>
                          )}

                          {txn.status === "SUCCESS" && txn.paymentId && txn.paymentId !== "unknown" && (
                            <Text as="p" tone="subdued" variant="bodySm">Payment ID: {txn.paymentId}</Text>
                          )}

                          {txn.status === "SUCCESS" && (
                            <InlineStack gap="300" blockAlign="center">
                              {txn.mode === "Manual" && txn.documentUrl && (
                                <a href={txn.documentUrl} target="_blank" rel="noreferrer" style={{ fontSize: "13px", color: "blue" }}>View Reference Doc</a>
                              )}
                              <Button variant="plain" size="micro" icon={ReceiptIcon} onClick={() => window.open(`/api/print-receipt?txId=${txn.id}`, '_blank')}>Print Receipt</Button>
                            </InlineStack>
                          )}
                        </BlockStack>
                      </List.Item>
                    ))}
                  </List>
                </BlockStack>
              </Card>
            )}

            {parcels.length > 0 && (
              <Card>
                <BlockStack gap="400">
                  <Text variant="headingMd" as="h2">Parcels</Text>
                  {parcels.map(parcel => (
                    <Box key={parcel.id} padding="300" background="bg-surface-secondary" borderRadius="200" borderWidth="025" borderColor="border">
                      <BlockStack gap="200">
                        <InlineStack align="space-between">
                          <Text as="span" fontWeight="bold">{parcel.carrierName}</Text>
                          <Badge tone="info">{parcel.dispatchStatus}</Badge>
                        </InlineStack>
                        <InlineStack align="space-between">
                          <Text as="span">Tracking AWB</Text>
                          <Text as="span">{parcel.awbNumber || "—"}</Text>
                        </InlineStack>
                        <InlineStack align="space-between">
                          <Text as="span">Dimensions (cm) & Weight (kg)</Text>
                          <Text as="span">{parcel.length}x{parcel.width}x{parcel.height} · {parcel.weight}kg</Text>
                        </InlineStack>
                        {parcel.dispatchmentId && (
                          <InlineStack align="space-between">
                            <Text as="span">Dispatchment ID</Text>
                            <Text as="span">#{parcel.dispatchmentId}</Text>
                          </InlineStack>
                        )}
                        <Box paddingBlockStart="200">
                          <Button size="micro" icon={DeliveryIcon} onClick={() => handlePrintLabel(parcel)} loading={printingParcelId === parcel.id}>
                            Print Label
                          </Button>
                        </Box>
                      </BlockStack>
                    </Box>
                  ))}
                </BlockStack>
              </Card>
            )}
          </BlockStack>
        </Layout.Section>

        <Layout.Section variant="oneThird">
          <Card>
            <BlockStack gap="400">
              <Text variant="headingMd" as="h2">Customer</Text>
              <Text as="p">{order.customerName || "No name"}</Text>
              {order.customerEmail && <Text as="p" tone="subdued">{order.customerEmail}</Text>}
              {order.customerPhone && <Text as="p">{order.customerPhone}</Text>}
            </BlockStack>
          </Card>

          <Box paddingBlockStart="400">
            <Card>
              <BlockStack gap="400">
                <Text variant="headingMd" as="h2">Shipping Address</Text>
                <Text as="p">
                  {order.address1}{order.address2 ? `, ${order.address2}` : ""}<br />
                  {order.city}{order.province ? `, ${order.province}` : ""}<br />
                  {order.zip} {order.country}
                </Text>
              </BlockStack>
            </Card>
          </Box>
        </Layout.Section>
      </Layout>

      {/* Add Payment Modal */}
      <Modal
        open={addPaymentOpen}
        onClose={() => setAddPaymentOpen(false)}
        title="Add Payment"
        primaryAction={{
          content: paymentMode === "Razorpay" ? "Generate Razorpay Link" : "Record Payment",
          onAction: handleAddPayment,
          loading: addPaymentFetcher.state === "submitting",
          disabled: !paymentAmount || parseFloat(paymentAmount) <= 0 || parseFloat(paymentAmount) > remainingDue || (paymentMode === "Manual" && !paymentFile)
        }}
        secondaryActions={[{ content: "Cancel", onAction: () => setAddPaymentOpen(false) }]}
      >
        <Modal.Section>
          {addPaymentFetcher.data?.error && <Banner tone="critical"><p>{addPaymentFetcher.data.error}</p></Banner>}
          <BlockStack gap="400">
            <FormLayout>
              <Select
                label="Payment Amount"
                options={[
                  { label: `Full Remaining Balance (₹${remainingDue.toFixed(2)})`, value: "full" },
                  { label: "Partial Payment", value: "partial" }
                ]}
                value={paymentType}
                onChange={setPaymentType}
              />
              {paymentType === "partial" && (
                <TextField
                  label="Amount (₹)"
                  type="number"
                  value={paymentAmount}
                  onChange={setPaymentAmount}
                  autoComplete="off"
                  min={1}
                  max={remainingDue}
                  helpText={`Amount should not exceed ₹${remainingDue.toFixed(2)}`}
                />
              )}

              <Select
                label="Payment Mode"
                options={[
                  { label: "Razorpay (Generate Link)", value: "Razorpay" },
                  { label: "Manual (Bank Transfer / Cash)", value: "Manual" }
                ]}
                value={paymentMode}
                onChange={setPaymentMode}
              />

              {paymentMode === "Manual" && (
                <div style={{ marginTop: '12px' }}>
                  <Text as="p" variant="bodyMd" fontWeight="semibold">Upload Payment Proof (Required)</Text>
                  <input type="file" onChange={(e) => setPaymentFile(e.target.files[0])} style={{ marginTop: '8px' }} />
                </div>
              )}

              {paymentMode === "Razorpay" && (
                <FormLayout.Group>
                  <TextField label="Notification Phone" value={paymentPhone} onChange={setPaymentPhone} autoComplete="off" />
                  <TextField label="Notification Email" value={paymentEmail} onChange={setPaymentEmail} autoComplete="off" />
                </FormLayout.Group>
              )}
            </FormLayout>
          </BlockStack>
        </Modal.Section>
      </Modal>

      {/* Edit Order Modal */}
      <EditOrderModal
        open={editModalOpen}
        onClose={() => setEditModalOpen(false)}
        order={order}
        hasPayment={hasPayment}
      />

      {/* Local Fulfillment Wizard */}
      <CustomFulfillmentWizard
        open={fulfillWizardOpen}
        onClose={() => setFulfillWizardOpen(false)}
        carriers={carriers}
        packages={packages}
        addons={addons}
        orderId={order.id}
        remainingCOD={remainingCOD}
      />

      {/* Delete Confirmation Modal */}
      <Modal
        open={deleteModalOpen}
        onClose={() => setDeleteModalOpen(false)}
        title="Delete Order"
        primaryAction={{
          content: "Delete",
          destructive: true,
          onAction: () => {
            submit({ intent: "delete" }, { method: "post", replace: true });
            navigate("/app/custom-orders", { replace: true });
          }
        }}
        secondaryActions={[{ content: "Cancel", onAction: () => setDeleteModalOpen(false) }]}
      >
        <Modal.Section>
          <Text as="p">Are you sure you want to delete this custom order? This will also remove any un-dispatched parcels if configured cascade delete (though best practice is to remove parcels first).</Text>
        </Modal.Section>
      </Modal>
    </Page>
  );
}

// --- EDIT ORDER MODAL ---
function EditOrderModal({ open, onClose, order, hasPayment }) {
  const fetcher = useFetcher();
  const searchFetcher = useFetcher();

  const [customerName, setCustomerName] = useState("");
  const [customerEmail, setCustomerEmail] = useState("");
  const [customerPhone, setCustomerPhone] = useState("");
  const [address1, setAddress1] = useState("");
  const [address2, setAddress2] = useState("");
  const [city, setCity] = useState("");
  const [province, setProvince] = useState("");
  const [zip, setZip] = useState("");
  const [country, setCountry] = useState("IN");
  const [orderType, setOrderType] = useState("Standard");

  const [items, setItems] = useState([]);
  const [discountType, setDiscountType] = useState("none");
  const [discountValue, setDiscountValue] = useState("");
  const [searchQuery, setSearchQuery] = useState("");

  useEffect(() => {
    if (open) {
      setCustomerName(order.customerName || "");
      setCustomerEmail(order.customerEmail || "");
      setCustomerPhone(order.customerPhone || "");
      setAddress1(order.address1 || "");
      setAddress2(order.address2 || "");
      setCity(order.city || "");
      setProvince(order.province || "");
      setZip(order.zip || "");
      setCountry(order.country || "IN");
      setOrderType(order.orderType || "Standard");
      setItems(order.items ? JSON.parse(order.items) : []);
      setDiscountType(order.discountType || "none");
      setDiscountValue(order.discountValue ? order.discountValue.toString() : "");
      setSearchQuery("");
    }
  }, [open, order]);

  useEffect(() => {
    if (searchQuery.length >= 2) {
      searchFetcher.submit({ q: searchQuery }, { method: "get", action: "/app/api/products" });
    }
  }, [searchQuery]);

  const searchResults = searchFetcher.data?.products || [];
  const options = searchResults.flatMap(p =>
    p.variants.map(v => ({
      value: v.id,
      label: `${p.title} - ${v.title} (₹${v.price})`,
      product: p,
      variant: v
    }))
  );

  const handleSelectProduct = (selected) => {
    const selectedVariantId = selected[0];
    const option = options.find(o => o.value === selectedVariantId);
    if (!option) return;

    setItems(prev => {
      const existing = prev.find(i => i.variantId === selectedVariantId);
      if (existing) {
        return prev.map(i => i.variantId === selectedVariantId ? { ...i, quantity: i.quantity + 1 } : i);
      }
      return [...prev, {
        productId: option.product.id,
        variantId: option.variant.id,
        title: `${option.product.title} - ${option.variant.title}`,
        price: parseFloat(option.variant.price),
        quantity: 1
      }];
    });
    setSearchQuery("");
  };

  const textFieldSearch = (
    <Autocomplete.TextField
      onChange={setSearchQuery}
      value={searchQuery}
      prefix={<Icon source={SearchIcon} tone="base" />}
      placeholder="Search products..."
      autoComplete="off"
    />
  );

  const productTotal = items.reduce((acc, item) => acc + item.price * item.quantity, 0);
  let dVal = parseFloat(discountValue) || 0;
  let totalAmount = productTotal;
  if (discountType === "fixed") totalAmount -= dVal;
  else if (discountType === "percent") totalAmount -= (totalAmount * dVal) / 100;
  if (totalAmount < 0) totalAmount = 0;

  const handleSave = () => {
    const fd = new FormData();
    fd.append("intent", "update");
    fd.append("customerName", customerName);
    fd.append("customerEmail", customerEmail);
    fd.append("customerPhone", customerPhone);
    fd.append("address1", address1);
    fd.append("address2", address2);
    fd.append("city", city);
    fd.append("province", province);
    fd.append("zip", zip);
    fd.append("country", country);
    fd.append("orderType", orderType);
    if (!hasPayment) {
      fd.append("items", JSON.stringify(items));
      fd.append("discountType", discountType);
      fd.append("discountValue", discountValue || "0");
    }
    fetcher.submit(fd, { method: "post" });
  };

  useEffect(() => {
    if (fetcher.data?.success && fetcher.data?.intent === "update") {
      shopify.toast.show("Order updated");
      onClose();
    }
  }, [fetcher.data, onClose]);

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={`Edit Order - ${order.orderName}`}
      primaryAction={{
        content: "Save Changes",
        onAction: handleSave,
        loading: fetcher.state === "submitting",
        disabled: !customerName || !customerPhone || !address1 || !city || !zip
      }}
      secondaryActions={[{ content: "Cancel", onAction: onClose }]}
      large
    >
      <Modal.Section>
        {fetcher.data?.error && <Banner tone="critical"><p>{fetcher.data.error}</p></Banner>}
        <BlockStack gap="400">
          <FormLayout>
            <Select label="Order Type" options={[{ label: "Standard", value: "Standard" }, { label: "PPCOD", value: "PPCOD" }, { label: "Advance Payment", value: "Advance Payment" }]} value={orderType} onChange={setOrderType} />
            <FormLayout.Group>
              <TextField label="Customer Name" value={customerName} onChange={setCustomerName} autoComplete="off" />
              <TextField label="Customer Email" value={customerEmail} onChange={setCustomerEmail} autoComplete="off" />
            </FormLayout.Group>
            <TextField label="Customer Phone" value={customerPhone} onChange={setCustomerPhone} autoComplete="off" />
          </FormLayout>
          <FormLayout>
            <TextField label="Address 1" value={address1} onChange={setAddress1} autoComplete="off" />
            <TextField label="Address 2" value={address2} onChange={setAddress2} autoComplete="off" />
            <FormLayout.Group>
              <TextField label="City" value={city} onChange={setCity} autoComplete="off" />
              <Select
                label="Province/State"
                options={[{ label: "Select State...", value: "" }, ...INDIAN_STATES.map(s => ({ label: s, value: s }))]}
                value={province}
                onChange={setProvince}
              />
            </FormLayout.Group>
            <FormLayout.Group>
              <TextField label="Postal Code" value={zip} onChange={setZip} autoComplete="off" />
              <TextField label="Country" value={country} onChange={setCountry} autoComplete="off" />
            </FormLayout.Group>
          </FormLayout>

          <Divider />

          <Text variant="headingMd" as="h3">Products</Text>
          {hasPayment ? (
            <BlockStack gap="200">
              <Banner tone="info"><p>Products can't be edited after a payment has been recorded.</p></Banner>
              {items.map((item, i) => (
                <InlineStack key={i} align="space-between">
                  <Text as="span">{item.quantity} x {item.title}</Text>
                  <Text as="span">₹{(item.price * item.quantity).toFixed(2)}</Text>
                </InlineStack>
              ))}
              <InlineStack align="space-between">
                <Text variant="headingSm" as="h4">Total Amount</Text>
                <Text variant="headingSm" as="h4">₹{order.totalAmount.toFixed(2)}</Text>
              </InlineStack>
            </BlockStack>
          ) : (
            <BlockStack gap="400">
              <Autocomplete options={options} selected={[]} onSelect={handleSelectProduct} textField={textFieldSearch} />

              {items.length > 0 && (
                <Box padding="300" background="bg-surface-secondary" borderRadius="200">
                  <BlockStack gap="300">
                    {items.map((item, index) => (
                      <Box key={item.variantId} padding="200" background="bg-surface" borderRadius="200" borderWidth="025" borderColor="border">
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                          <Text as="span">{item.title}</Text>
                          <div style={{ display: 'flex', gap: '12px', alignItems: 'center' }}>
                            <Text as="span">₹{(item.price * item.quantity).toFixed(2)}</Text>
                            <div style={{ width: '80px' }}>
                              <TextField
                                type="number" min={1} value={item.quantity.toString()}
                                onChange={(val) => {
                                  const newItems = [...items];
                                  newItems[index].quantity = Math.max(1, parseInt(val, 10) || 1);
                                  setItems(newItems);
                                }}
                                autoComplete="off"
                              />
                            </div>
                            <Button icon={DeleteIcon} tone="critical" variant="plain" onClick={() => setItems(items.filter((_, i) => i !== index))} />
                          </div>
                        </div>
                      </Box>
                    ))}

                    <Divider />

                    <FormLayout>
                      <FormLayout.Group>
                        <Select
                          label="Add Discount"
                          options={[{ label: "None", value: "none" }, { label: "Fixed Amount (₹)", value: "fixed" }, { label: "Percentage (%)", value: "percent" }]}
                          value={discountType} onChange={setDiscountType}
                        />
                        {discountType !== "none" && (
                          <TextField label="Discount Value" type="number" value={discountValue} onChange={setDiscountValue} autoComplete="off" />
                        )}
                      </FormLayout.Group>
                    </FormLayout>

                    <div style={{ borderTop: "1px solid var(--p-color-border)", paddingTop: "12px", textAlign: "right" }}>
                      <Text as="p" tone="subdued">Subtotal: ₹{productTotal.toFixed(2)}</Text>
                      <Text variant="headingMd" as="h3">Grand Total: ₹{totalAmount.toFixed(2)}</Text>
                    </div>
                  </BlockStack>
                </Box>
              )}
            </BlockStack>
          )}
        </BlockStack>
      </Modal.Section>
    </Modal>
  );
}

// --- LOCAL FULFILLMENT WIZARD ---
function CustomFulfillmentWizard({ open, onClose, carriers, packages, addons, orderId, remainingCOD = 0 }) {
  const fetcher = useFetcher();
  const labelFetcher = useFetcher();

  const [step, setStep] = useState(1);
  const [selectedCarrier, setSelectedCarrier] = useState("");
  const [selectedPackage, setSelectedPackage] = useState("");
  const [awbNumber, setAwbNumber] = useState("");
  const [parcelLength, setParcelLength] = useState("");
  const [parcelWidth, setParcelWidth] = useState("");
  const [parcelHeight, setParcelHeight] = useState("");
  const [parcelWeight, setParcelWeight] = useState("");
  const [parcelVOR, setParcelVOR] = useState("");

  const [selectedAddons, setSelectedAddons] = useState([]);
  const [selectedAddonId, setSelectedAddonId] = useState("");

  const [createdParcel, setCreatedParcel] = useState(null);
  const [labelPrinted, setLabelPrinted] = useState(false);

  useEffect(() => {
    if (open) {
      setStep(1); setCreatedParcel(null); setLabelPrinted(false);
      setSelectedCarrier(""); setSelectedPackage(""); setAwbNumber("");
      setParcelLength(""); setParcelWidth(""); setParcelHeight(""); setParcelWeight("");
      setParcelVOR(remainingCOD.toString());
      setSelectedAddons([]); setSelectedAddonId("");
    }
  }, [open, remainingCOD]);

  useEffect(() => {
    if (fetcher.data?.success && step === 2) {
      setCreatedParcel(fetcher.data.parcel);
      setStep(3);
      // Initiate label fetching
      const fd = new FormData();
      fd.append("intent", "getLabelData");
      fd.append("orderId", `custom-${orderId}`);
      labelFetcher.submit(fd, { method: "post", action: "/api/print-label" });
    }
  }, [fetcher.data, step, orderId, labelFetcher]);

  useEffect(() => {
    if (labelFetcher.state === "idle" && labelFetcher.data?.intent === "getLabelData" && createdParcel && step === 3 && !labelPrinted) {
      if (labelFetcher.data.order && labelFetcher.data.shop) {
        const fullParcel = labelFetcher.data.parcels?.find(p => p.id === createdParcel.id) || createdParcel;
        printLabel({
          order: labelFetcher.data.order, shop: labelFetcher.data.shop,
          parcel: fullParcel, printSettings: labelFetcher.data.printSettings
        });
        setLabelPrinted(true);
      }
    }
  }, [labelFetcher.state, labelFetcher.data, createdParcel, step, labelPrinted]);

  const handlePackageChange = (val) => {
    setSelectedPackage(val);
    const pkg = packages.find(p => p.id.toString() === val);
    if (pkg) {
      setParcelLength(pkg.length.toString()); setParcelWidth(pkg.width.toString());
      setParcelHeight(pkg.height.toString()); setParcelWeight(pkg.weight.toString());
      const pkgVORVal = parseFloat(pkg.valueOfRepayment);
      if (pkg.valueOfRepayment && !isNaN(pkgVORVal) && pkgVORVal <= remainingCOD) {
        setParcelVOR(pkg.valueOfRepayment);
      } else {
        setParcelVOR(remainingCOD.toString());
      }
    } else {
      setParcelLength(""); setParcelWidth(""); setParcelHeight(""); setParcelWeight(""); setParcelVOR(remainingCOD.toString());
    }
  };

  const handleFulfill = () => {
    const fd = new FormData();
    fd.append("intent", "fulfill");
    fd.append("awbNumber", awbNumber);
    const c = carriers.find(c => c.id.toString() === selectedCarrier);
    fd.append("carrierId", c?.id || "");
    fd.append("carrierName", c?.name || "");
    fd.append("parcelLength", parcelLength);
    fd.append("parcelWidth", parcelWidth);
    fd.append("parcelHeight", parcelHeight);
    fd.append("parcelWeight", parcelWeight);
    fd.append("parcelValueOfRepayment", parcelVOR);
    fd.append("addonPayload", JSON.stringify(selectedAddons));
    fetcher.submit(fd, { method: "post" });
  };

  const handlePrintAgain = () => {
    if (labelFetcher.data?.order && labelFetcher.data?.shop && createdParcel) {
      const fullParcel = labelFetcher.data.parcels?.find(p => p.id === createdParcel.id) || createdParcel;
      printLabel({
        order: labelFetcher.data.order, shop: labelFetcher.data.shop,
        parcel: fullParcel, printSettings: labelFetcher.data.printSettings
      });
    }
  };

  const vorNum = parseFloat(parcelVOR);
  const isVorInvalid = !isNaN(vorNum) && vorNum > remainingCOD;
  const vorError = isVorInvalid ? `COD amount cannot exceed remaining order amount (₹${remainingCOD})` : "";

  let primaryAction;
  if (step === 3) {
    primaryAction = { content: "Done", onAction: onClose };
  } else {
    primaryAction = {
      content: step === 2 ? "Complete Fulfillment" : "Next",
      onAction: step === 2 ? handleFulfill : () => setStep(s => s + 1),
      loading: fetcher.state === "submitting",
      disabled: step === 1 && (!awbNumber || !selectedCarrier || !selectedPackage || isVorInvalid)
    };
  }

  const secondaryActions = step === 3 && createdParcel
    ? [{ content: "Print Label Again", onAction: handlePrintAgain }]
    : (step === 2 ? [{ content: "Back", onAction: () => setStep(1) }] : [{ content: "Cancel", onAction: onClose }]);

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={step === 3 ? "Fulfillment Complete" : `Create Fulfillment - Step ${step} of 2`}
      primaryAction={primaryAction}
      secondaryActions={secondaryActions}
      large
    >
      <Modal.Section>
        {fetcher.data?.error && <Banner tone="critical"><p>{fetcher.data.error}</p></Banner>}

        {step === 1 && (
          <BlockStack gap="400">
            <Text variant="headingMd" as="h3">Parcel Details</Text>
            <FormLayout>
              <Select label="Shipping Carrier" options={[{ label: "Select...", value: "" }, ...carriers.map(c => ({ label: c.name, value: c.id.toString() }))]} value={selectedCarrier} onChange={setSelectedCarrier} />
              <TextField label="AWB Tracking Number" value={awbNumber} onChange={setAwbNumber} autoComplete="off" />
              <Select label="Package Profile" options={[{ label: "Select...", value: "" }, ...packages.map(p => ({ label: p.name, value: p.id.toString() })), { label: "Custom", value: "custom" }]} value={selectedPackage} onChange={handlePackageChange} />
              <FormLayout.Group>
                <TextField label="Length (cm)" type="number" value={parcelLength} onChange={setParcelLength} autoComplete="off" disabled={selectedPackage !== "custom" && selectedPackage !== ""} />
                <TextField label="Width (cm)" type="number" value={parcelWidth} onChange={setParcelWidth} autoComplete="off" disabled={selectedPackage !== "custom" && selectedPackage !== ""} />
              </FormLayout.Group>
              <FormLayout.Group>
                <TextField label="Height (cm)" type="number" value={parcelHeight} onChange={setParcelHeight} autoComplete="off" disabled={selectedPackage !== "custom" && selectedPackage !== ""} />
                <TextField label="Weight (kg)" type="number" value={parcelWeight} onChange={setParcelWeight} autoComplete="off" disabled={selectedPackage !== "custom" && selectedPackage !== ""} />
              </FormLayout.Group>
              <TextField label="COD amount" type="number" value={parcelVOR} onChange={setParcelVOR} autoComplete="off" error={vorError} />
            </FormLayout>
          </BlockStack>
        )}

        {step === 2 && (
          <BlockStack gap="400">
            <Text variant="headingMd" as="h3">Free Add-ons</Text>
            {addons && addons.length > 0 ? (
              <Box padding="300" background="bg-surface-secondary" borderRadius="200">
                <BlockStack gap="400">
                  <div style={{ display: 'flex', gap: '8px', alignItems: 'flex-end' }}>
                    <div style={{ flex: 1 }}>
                      <Select
                        label="Select Add-on to Include"
                        options={[{ label: "Choose an add-on...", value: "" }, ...addons.filter(a => !selectedAddons.find(sa => sa.id === a.id.toString())).map(a => ({ label: `${a.name} (${a.stock} left)`, value: a.id.toString() }))]}
                        value={selectedAddonId}
                        onChange={setSelectedAddonId}
                      />
                    </div>
                    <Button
                      onClick={() => {
                        const addon = addons.find(a => a.id.toString() === selectedAddonId);
                        if (addon) {
                          setSelectedAddons([...selectedAddons, { id: addon.id.toString(), name: addon.name, quantity: 1, maxStock: addon.stock }]);
                          setSelectedAddonId("");
                        }
                      }}
                      disabled={!selectedAddonId}
                    >
                      Add Item
                    </Button>
                  </div>
                  {selectedAddons.length > 0 && (
                    <BlockStack gap="300">
                      <Divider />
                      <Text variant="headingSm" as="h4">Included Add-ons</Text>
                      {selectedAddons.map((item, index) => (
                        <Box key={item.id} padding="200" background="bg-surface" borderRadius="200" borderWidth="025" borderColor="border">
                          <InlineStack gap="300" align="space-between" blockAlign="center">
                            <Text as="span" variant="bodyMd" fontWeight="semibold">{item.name}</Text>
                            <InlineStack gap="300" blockAlign="center">
                              <Text tone="subdued" as="span">Max: {item.maxStock}</Text>
                              <div style={{ width: '100px' }}>
                                <TextField
                                  type="number" min={1} max={item.maxStock} value={item.quantity.toString()}
                                  onChange={(val) => {
                                    let newQty = parseInt(val, 10);
                                    if (isNaN(newQty) || newQty < 1) newQty = 1;
                                    if (newQty > item.maxStock) newQty = item.maxStock;
                                    const newAddons = [...selectedAddons];
                                    newAddons[index].quantity = newQty;
                                    setSelectedAddons(newAddons);
                                  }}
                                  autoComplete="off" label="Qty" labelHidden
                                />
                              </div>
                              <Button icon={DeleteIcon} tone="critical" variant="plain" onClick={() => setSelectedAddons(selectedAddons.filter(a => a.id !== item.id))} />
                            </InlineStack>
                          </InlineStack>
                        </Box>
                      ))}
                    </BlockStack>
                  )}
                </BlockStack>
              </Box>
            ) : <Text tone="subdued">No active add-ons available.</Text>}
          </BlockStack>
        )}

        {step === 3 && (
          <BlockStack gap="400" inlineAlign="center">
            <Box paddingBlockStart="400" paddingBlockEnd="200">
              <BlockStack gap="300" inlineAlign="center">
                <div style={{ color: "#008060" }}><Icon source={CheckCircleIcon} tone="success" /></div>
                <Text variant="headingLg" as="h2" alignment="center">Fulfillment Created Successfully!</Text>
              </BlockStack>
            </Box>
            {labelFetcher.state !== "idle" && <BlockStack gap="200" inlineAlign="center"><Spinner size="small" /><Text tone="subdued">Preparing label...</Text></BlockStack>}
            {labelPrinted && <Banner tone="success"><p>Label generated.</p></Banner>}
          </BlockStack>
        )}
      </Modal.Section>
    </Modal>
  );
}
