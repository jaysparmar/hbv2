import {
  useLoaderData,
  useNavigate,
  useSubmit,
  useNavigation,
  useSearchParams,
  useFetcher,
} from "@remix-run/react";
import {
  Page,
  Layout,
  Card,
  IndexTable,
  Badge,
  Text,
  useIndexResourceState,
  IndexFilters,
  useSetIndexFiltersMode,
  ChoiceList,
  List,
  BlockStack,
  TextField,
  Pagination,
  Button,
  Modal,
  InlineStack,
  Avatar,
  Thumbnail,
  FormLayout,
  Select,
  Banner,
  Divider,
  Box,
  Spinner,
} from "@shopify/polaris";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import FulfillmentWizard from "../components/FulfillmentWizard";
import { printInvoice } from "../utils/printInvoice";
import { useState, useCallback, useEffect, useRef } from "react";
import { ReceiptIcon } from "@shopify/polaris-icons";

// ─── Loader ──────────────────────────────────────────────────────────────────

export const loader = async ({ request }) => {
  const { admin } = await authenticate.admin(request);
  const url = new URL(request.url);

  const q = url.searchParams.get("q") || "";
  const paymentStatus = url.searchParams.get("paymentStatus") || "";
  const fulfillmentStatus = url.searchParams.get("fulfillmentStatus") || "";
  const dateMin = url.searchParams.get("dateMin") || "";
  const dateMax = url.searchParams.get("dateMax") || "";
  const cursor = url.searchParams.get("cursor") || "";
  const direction = url.searchParams.get("direction") || "next";

  let queryParts = [];
  if (q) queryParts.push(`${q}`);
  if (paymentStatus) queryParts.push(`financial_status:${paymentStatus}`);
  if (fulfillmentStatus) queryParts.push(`fulfillment_status:${fulfillmentStatus}`);
  if (dateMin) queryParts.push(`created_at:>=${dateMin}`);
  if (dateMax) queryParts.push(`created_at:<=${dateMax}`);
  const queryStr = queryParts.join(" ");

  const paginationArgs = cursor
    ? direction === "next"
      ? `first: 20, after: "${cursor}"`
      : `last: 20, before: "${cursor}"`
    : `first: 20`;

  const response = await admin.graphql(
    `#graphql
      query getOrders($query: String) {
        orders(${paginationArgs}, sortKey: CREATED_AT, reverse: true, query: $query) {
          pageInfo { hasNextPage hasPreviousPage startCursor endCursor }
          edges {
            node {
              id name createdAt displayFinancialStatus displayFulfillmentStatus
              totalPriceSet { shopMoney { amount currencyCode } }
              customer { firstName lastName }
            }
          }
        }
      }`,
    { variables: { query: queryStr || null } }
  );

  const responseJson = await response.json();
  const ordersData = responseJson?.data?.orders || { edges: [], pageInfo: {} };
  const orders = ordersData.edges.map((edge) => edge.node);
  const pageInfo = ordersData.pageInfo;

  const staff = await prisma.staffMember.findMany({ orderBy: { name: "asc" } });
  const carriers = await prisma.carrier.findMany({ where: { isActive: true }, orderBy: { name: "asc" } });
  const packages = await prisma.package.findMany({ orderBy: { name: "asc" } });

  return { orders, pageInfo, q, paymentStatus, fulfillmentStatus, dateMin, dateMax, staff, carriers, packages };
};

// ─── Action ───────────────────────────────────────────────────────────────────

export const action = async ({ request }) => {
  const { admin } = await authenticate.admin(request);
  const formData = await request.formData();
  const intent = formData.get("intent");

  if (intent !== "createOrder") return { error: "Unknown intent." };

  const customerId = formData.get("customerId");
  const customerEmail = formData.get("customerEmail") || "";
  const customerName = formData.get("customerName") || "";
  const customerPhone = formData.get("customerPhone") || "";
  const lineItems = JSON.parse(formData.get("lineItems") || "[]");
  const shippingAddress = JSON.parse(formData.get("shippingAddress") || "{}");
  const gateway = formData.get("gateway");
  const paymentTerm = formData.get("paymentTerm") || "full";
  const partialAmount = formData.get("partialAmount") || "";

  const staffName = formData.get("staffName") || "";
  const customAttributes = staffName ? [{ key: "Staff Member", value: staffName }] : undefined;

  // Build DraftOrderInput
  const draftInput = {
    customAttributes,
    customerId,
    lineItems: lineItems.map((item) => ({
      variantId: item.variantId,
      quantity: parseInt(item.quantity, 10),
    })),
    shippingAddress: {
      firstName: shippingAddress.firstName || "",
      lastName: shippingAddress.lastName || "",
      address1: shippingAddress.address1 || "",
      address2: shippingAddress.address2 || "",
      city: shippingAddress.city || "",
      province: shippingAddress.province || "",
      zip: shippingAddress.zip || "",
      countryCode: shippingAddress.countryCode || "IN",
      phone: shippingAddress.phone || "",
    },
    tags: gateway === "razorpay" ? ["razorpay-pending"] : [],
  };

  // Create draft order
  const draftResp = await admin.graphql(
    `#graphql
    mutation draftOrderCreate($input: DraftOrderInput!) {
      draftOrderCreate(input: $input) {
        draftOrder {
          id name
          totalPriceSet { shopMoney { amount currencyCode } }
        }
        userErrors { field message }
      }
    }`,
    { variables: { input: draftInput } }
  );

  const draftJson = await draftResp.json();
  const draftOrder = draftJson?.data?.draftOrderCreate?.draftOrder;
  const draftErrors = draftJson?.data?.draftOrderCreate?.userErrors || [];

  if (draftErrors.length > 0) {
    return { error: draftErrors.map((e) => e.message).join(", ") };
  }
  if (!draftOrder) {
    return { error: "Failed to create draft order." };
  }

  // ── Manual gateway ──────────────────────────────────────────────────────────
  if (gateway === "manual") {
    const completeResp = await admin.graphql(
      `#graphql
            mutation draftOrderComplete($id: ID!) {
                draftOrderComplete(id: $id) {
                    draftOrder { order { id name } }
                    userErrors { field message }
                }
            }`,
      { variables: { id: draftOrder.id } }
    );

    const completeJson = await completeResp.json();
    const completeErrors = completeJson?.data?.draftOrderComplete?.userErrors || [];
    if (completeErrors.length > 0) {
      return { error: completeErrors.map((e) => e.message).join(", ") };
    }

    const completedOrder = completeJson?.data?.draftOrderComplete?.draftOrder?.order;
    return {
      success: true,
      type: "manual",
      orderName: completedOrder?.name || draftOrder.name,
    };
  }

  // ── Razorpay gateway ────────────────────────────────────────────────────────
  if (gateway === "razorpay") {
    const [keyIdRow, keySecretRow] = await Promise.all([
      prisma.setting.findUnique({ where: { key: "razorpay_key_id" } }),
      prisma.setting.findUnique({ where: { key: "razorpay_key_secret" } }),
    ]);

    if (!keyIdRow?.value || !keySecretRow?.value) {
      return {
        error: "Razorpay API keys are not configured. Go to Settings → Payment Gateway.",
      };
    }

    const totalAmount = parseFloat(draftOrder.totalPriceSet.shopMoney.amount);
    const amountToPay =
      paymentTerm === "partial" ? parseFloat(partialAmount) : totalAmount;

    if (isNaN(amountToPay) || amountToPay <= 0) {
      return { error: "Invalid payment amount." };
    }

    const credentials = Buffer.from(
      `${keyIdRow.value}:${keySecretRow.value}`
    ).toString("base64");

    const rzpResp = await fetch("https://api.razorpay.com/v1/payment_links", {
      method: "POST",
      headers: {
        Authorization: `Basic ${credentials}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        amount: Math.round(amountToPay * 100),
        currency: "INR",
        description: `Payment for ${draftOrder.name}`,
        reference_id: draftOrder.id.split("/").pop(),
        customer: {
          name: customerName,
          email: customerEmail,
          contact: customerPhone,
        },
        notify: {
          sms: !!customerPhone,
          email: !!customerEmail,
        },
      }),
    });

    const rzpData = await rzpResp.json();
    if (!rzpResp.ok || !rzpData.short_url) {
      return {
        error:
          rzpData.error?.description ||
          "Failed to create Razorpay payment link.",
      };
    }

    return {
      success: true,
      type: "razorpay",
      paymentLink: rzpData.short_url,
      draftOrderName: draftOrder.name,
      totalAmount: totalAmount.toFixed(2),
      paidAmount: amountToPay.toFixed(2),
    };
  }

  return { error: "Invalid gateway." };
};

// ─── Orders list ──────────────────────────────────────────────────────────────

export default function Index() {
  const { orders, pageInfo, q, paymentStatus, fulfillmentStatus, dateMin, dateMax, staff, carriers, packages } =
    useLoaderData();
  const navigate = useNavigate();
  const submit = useSubmit();
  const navigation = useNavigation();
  const isLoading = navigation.state === "loading";

  const { mode, setMode } = useSetIndexFiltersMode();

  const [queryValue, setQueryValue] = useState(q);
  const [paymentStatusValue, setPaymentStatusValue] = useState(
    paymentStatus ? paymentStatus.split(",") : []
  );
  const [fulfillmentStatusValue, setFulfillmentStatusValue] = useState(
    fulfillmentStatus ? fulfillmentStatus.split(",") : []
  );
  const [dateMinValue, setDateMinValue] = useState(dateMin);
  const [dateMaxValue, setDateMaxValue] = useState(dateMax);
  const [showCreateModal, setShowCreateModal] = useState(false);

  // Fulfillment wizard state
  const [fulfillWizardOpen, setFulfillWizardOpen] = useState(false);
  const [fulfillTargetOrder, setFulfillTargetOrder] = useState(null);

  const handleOpenFulfillWizard = useCallback((order) => {
    setFulfillTargetOrder(order);
    setFulfillWizardOpen(true);
  }, []);

  const closeFulfillWizard = useCallback(() => {
    setFulfillWizardOpen(false);
    setFulfillTargetOrder(null);
  }, []);

  // Print Invoice state
  const invoiceFetcher = useFetcher();
  const [invoiceOrderId, setInvoiceOrderId] = useState(null);

  const handlePrintInvoice = useCallback((orderId) => {
    setInvoiceOrderId(orderId);
    const fd = new FormData();
    fd.append("intent", "getLabelData");
    fd.append("orderId", orderId);
    invoiceFetcher.submit(fd, { method: "post", action: "/api/print-label" });
  }, [invoiceFetcher]);

  useEffect(() => {
    if (invoiceFetcher.state !== "idle" || !invoiceFetcher.data) return;
    if (invoiceFetcher.data.intent === "getLabelData" && invoiceOrderId) {
      if (invoiceFetcher.data.order && invoiceFetcher.data.shop) {
        printInvoice({ order: invoiceFetcher.data.order, shop: invoiceFetcher.data.shop });
      }
      setInvoiceOrderId(null);
    }
  }, [invoiceFetcher.state, invoiceFetcher.data, invoiceOrderId]);

  const timeoutId = useRef(null);

  useEffect(() => {
    setQueryValue(q);
    setPaymentStatusValue(paymentStatus ? paymentStatus.split(",") : []);
    setFulfillmentStatusValue(fulfillmentStatus ? fulfillmentStatus.split(",") : []);
    setDateMinValue(dateMin);
    setDateMaxValue(dateMax);
  }, [q, paymentStatus, fulfillmentStatus, dateMin, dateMax]);

  const handleFiltersQueryChange = useCallback(
    (value) => {
      setQueryValue(value);
      if (timeoutId.current) clearTimeout(timeoutId.current);
      timeoutId.current = setTimeout(() => {
        const fd = new FormData();
        if (value) fd.append("q", value);
        if (paymentStatusValue.length) fd.append("paymentStatus", paymentStatusValue.join(","));
        if (fulfillmentStatusValue.length) fd.append("fulfillmentStatus", fulfillmentStatusValue.join(","));
        if (dateMinValue) fd.append("dateMin", dateMinValue);
        if (dateMaxValue) fd.append("dateMax", dateMaxValue);
        submit(fd, { method: "get" });
      }, 500);
    },
    [paymentStatusValue, fulfillmentStatusValue, dateMinValue, dateMaxValue, submit]
  );

  const handlePaymentStatusChange = useCallback(
    (value) => {
      setPaymentStatusValue(value);
      const fd = new FormData();
      if (queryValue) fd.append("q", queryValue);
      if (value.length) fd.append("paymentStatus", value.join(","));
      if (fulfillmentStatusValue.length) fd.append("fulfillmentStatus", fulfillmentStatusValue.join(","));
      if (dateMinValue) fd.append("dateMin", dateMinValue);
      if (dateMaxValue) fd.append("dateMax", dateMaxValue);
      submit(fd, { method: "get" });
    },
    [queryValue, fulfillmentStatusValue, dateMinValue, dateMaxValue, submit]
  );

  const handleFulfillmentStatusChange = useCallback(
    (value) => {
      setFulfillmentStatusValue(value);
      const fd = new FormData();
      if (queryValue) fd.append("q", queryValue);
      if (paymentStatusValue.length) fd.append("paymentStatus", paymentStatusValue.join(","));
      if (value.length) fd.append("fulfillmentStatus", value.join(","));
      if (dateMinValue) fd.append("dateMin", dateMinValue);
      if (dateMaxValue) fd.append("dateMax", dateMaxValue);
      submit(fd, { method: "get" });
    },
    [queryValue, paymentStatusValue, dateMinValue, dateMaxValue, submit]
  );

  const handleDateMinChange = useCallback(
    (value) => {
      setDateMinValue(value);
      const fd = new FormData();
      if (queryValue) fd.append("q", queryValue);
      if (paymentStatusValue.length) fd.append("paymentStatus", paymentStatusValue.join(","));
      if (fulfillmentStatusValue.length) fd.append("fulfillmentStatus", fulfillmentStatusValue.join(","));
      if (value) fd.append("dateMin", value);
      if (dateMaxValue) fd.append("dateMax", dateMaxValue);
      submit(fd, { method: "get", replace: true });
    },
    [queryValue, paymentStatusValue, fulfillmentStatusValue, dateMaxValue, submit]
  );

  const handleDateMaxChange = useCallback(
    (value) => {
      setDateMaxValue(value);
      const fd = new FormData();
      if (queryValue) fd.append("q", queryValue);
      if (paymentStatusValue.length) fd.append("paymentStatus", paymentStatusValue.join(","));
      if (fulfillmentStatusValue.length) fd.append("fulfillmentStatus", fulfillmentStatusValue.join(","));
      if (dateMinValue) fd.append("dateMin", dateMinValue);
      if (value) fd.append("dateMax", value);
      submit(fd, { method: "get", replace: true });
    },
    [queryValue, paymentStatusValue, fulfillmentStatusValue, dateMinValue, submit]
  );

  const handleFiltersClearAll = useCallback(() => {
    setQueryValue("");
    setPaymentStatusValue([]);
    setFulfillmentStatusValue([]);
    setDateMinValue("");
    setDateMaxValue("");
    submit({}, { method: "get" });
  }, [submit]);

  const filters = [
    {
      key: "paymentStatus",
      label: "Payment Status",
      filter: (
        <ChoiceList
          title="Payment Status"
          titleHidden
          choices={[
            { label: "Paid", value: "paid" },
            { label: "Pending", value: "pending" },
            { label: "Refunded", value: "refunded" },
            { label: "Voided", value: "voided" },
          ]}
          selected={paymentStatusValue}
          onChange={handlePaymentStatusChange}
          allowMultiple
        />
      ),
      shortcut: true,
    },
    {
      key: "fulfillmentStatus",
      label: "Fulfillment Status",
      filter: (
        <ChoiceList
          title="Fulfillment Status"
          titleHidden
          choices={[
            { label: "Fulfilled", value: "fulfilled" },
            { label: "Unfulfilled", value: "unfulfilled" },
            { label: "Partially fulfilled", value: "partial" },
          ]}
          selected={fulfillmentStatusValue}
          onChange={handleFulfillmentStatusChange}
          allowMultiple
        />
      ),
      shortcut: true,
    },
    {
      key: "dateRange",
      label: "Date range",
      filter: (
        <div style={{ display: "flex", flexDirection: "column", gap: "12px", padding: "8px" }}>
          <TextField
            label="Since"
            type="date"
            value={dateMinValue}
            onChange={handleDateMinChange}
            autoComplete="off"
          />
          <TextField
            label="Until"
            type="date"
            value={dateMaxValue}
            onChange={handleDateMaxChange}
            autoComplete="off"
          />
        </div>
      ),
    },
  ];

  const appliedFilters = [];
  if (paymentStatusValue?.length > 0) {
    appliedFilters.push({
      key: "paymentStatus",
      label: `Payment: ${paymentStatusValue.join(", ")}`,
      onRemove: () => {
        setPaymentStatusValue([]);
        const fd = new FormData();
        if (queryValue) fd.append("q", queryValue);
        if (fulfillmentStatusValue.length) fd.append("fulfillmentStatus", fulfillmentStatusValue.join(","));
        if (dateMinValue) fd.append("dateMin", dateMinValue);
        if (dateMaxValue) fd.append("dateMax", dateMaxValue);
        submit(fd, { method: "get" });
      },
    });
  }
  if (fulfillmentStatusValue?.length > 0) {
    appliedFilters.push({
      key: "fulfillmentStatus",
      label: `Fulfillment: ${fulfillmentStatusValue.join(", ")}`,
      onRemove: () => {
        setFulfillmentStatusValue([]);
        const fd = new FormData();
        if (queryValue) fd.append("q", queryValue);
        if (paymentStatusValue.length) fd.append("paymentStatus", paymentStatusValue.join(","));
        if (dateMinValue) fd.append("dateMin", dateMinValue);
        if (dateMaxValue) fd.append("dateMax", dateMaxValue);
        submit(fd, { method: "get" });
      },
    });
  }
  if (dateMinValue || dateMaxValue) {
    appliedFilters.push({
      key: "dateRange",
      label: `Date: ${dateMinValue || "-"} to ${dateMaxValue || "-"}`,
      onRemove: () => {
        setDateMinValue("");
        setDateMaxValue("");
        const fd = new FormData();
        if (queryValue) fd.append("q", queryValue);
        if (paymentStatusValue.length) fd.append("paymentStatus", paymentStatusValue.join(","));
        if (fulfillmentStatusValue.length) fd.append("fulfillmentStatus", fulfillmentStatusValue.join(","));
        submit(fd, { method: "get" });
      },
    });
  }

  const resourceName = { singular: "order", plural: "orders" };
  const { selectedResources, allResourcesSelected, handleSelectionChange } =
    useIndexResourceState(orders);

  const [searchParams] = useSearchParams();
  const pageNumber = parseInt(searchParams.get("page") || "1", 10);

  const rowMarkup = orders.map(
    ({ id, name, createdAt, displayFinancialStatus, displayFulfillmentStatus, totalPriceSet, customer }, index) => {
      const orderId = id.split("/").pop();
      const customerName = customer
        ? `${customer.firstName || ""} ${customer.lastName || ""}`.trim()
        : "No customer";
      const date = new Date(createdAt).toLocaleDateString();
      const price = new Intl.NumberFormat("en-US", {
        style: "currency",
        currency: totalPriceSet.shopMoney.currencyCode,
      }).format(totalPriceSet.shopMoney.amount);

      const canFulfill = displayFulfillmentStatus !== "FULFILLED";

      return (
        <IndexTable.Row
          id={id}
          key={id}
          selected={selectedResources.includes(id)}
          position={index}
          onClick={() => navigate(`/app/orders/${orderId}`)}
        >
          <IndexTable.Cell>
            <Text variant="bodyMd" fontWeight="bold" as="span">{name}</Text>
          </IndexTable.Cell>
          <IndexTable.Cell>{date}</IndexTable.Cell>
          <IndexTable.Cell>{customerName}</IndexTable.Cell>
          <IndexTable.Cell>{price}</IndexTable.Cell>
          <IndexTable.Cell>
            <Badge
              tone={
                displayFinancialStatus === "PAID" ? "success"
                  : displayFinancialStatus === "PENDING" ? "warning"
                    : "new"
              }
            >
              {displayFinancialStatus || "UNKNOWN"}
            </Badge>
          </IndexTable.Cell>
          <IndexTable.Cell>
            <Badge
              tone={
                displayFulfillmentStatus === "FULFILLED" ? "success"
                  : displayFulfillmentStatus === "UNFULFILLED" ? "attention"
                    : "new"
              }
            >
              {displayFulfillmentStatus || "UNFULFILLED"}
            </Badge>
          </IndexTable.Cell>
          <IndexTable.Cell>
            <InlineStack gap="200">
              <Button
                size="micro"
                icon={ReceiptIcon}
                onClick={(e) => {
                  e.stopPropagation();
                  handlePrintInvoice(id);
                }}
                loading={invoiceOrderId === id}
                accessibilityLabel="Print Invoice"
              />
              {canFulfill && (
                <Button
                  size="micro"
                  onClick={(e) => {
                    e.stopPropagation();
                    handleOpenFulfillWizard({ id, name });
                  }}
                >
                  Create Fulfillment
                </Button>
              )}
            </InlineStack>
          </IndexTable.Cell>
        </IndexTable.Row>
      );
    }
  );

  return (
    <Page
      fullWidth
      title="Orders"
      primaryAction={
        <Button variant="primary" onClick={() => setShowCreateModal(true)}>
          Create order
        </Button>
      }
    >
      <Layout>
        <Layout.Section>
          <Card padding="0">
            <IndexFilters
              sortOptions={[]}
              sortSelected={[]}
              onSort={() => { }}
              queryValue={queryValue}
              queryPlaceholder="Searching in all"
              onQueryChange={handleFiltersQueryChange}
              onQueryClear={() => {
                setQueryValue("");
                const fd = new FormData();
                if (paymentStatusValue.length) fd.append("paymentStatus", paymentStatusValue.join(","));
                if (fulfillmentStatusValue.length) fd.append("fulfillmentStatus", fulfillmentStatusValue.join(","));
                if (dateMinValue) fd.append("dateMin", dateMinValue);
                if (dateMaxValue) fd.append("dateMax", dateMaxValue);
                submit(fd, { method: "get" });
              }}
              cancelAction={{ onAction: () => { }, disabled: false, loading: false }}
              tabs={[{ content: "All", id: "all" }]}
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
              itemCount={orders.length}
              selectedItemsCount={allResourcesSelected ? "All" : selectedResources.length}
              onSelectionChange={handleSelectionChange}
              headings={[
                { title: "Order" },
                { title: "Date" },
                { title: "Customer" },
                { title: "Total" },
                { title: "Payment Status" },
                { title: "Fulfillment Status" },
                { title: "Actions" },
              ]}
              selectable={false}
              loading={isLoading}
            >
              {rowMarkup}
            </IndexTable>
            <div style={{ display: "flex", justifyContent: "center", padding: "16px" }}>
              <Pagination
                label={`Page ${pageNumber}`}
                hasPrevious={pageInfo?.hasPreviousPage}
                onPrevious={() => {
                  const fd = new FormData();
                  if (queryValue) fd.append("q", queryValue);
                  if (paymentStatusValue.length) fd.append("paymentStatus", paymentStatusValue.join(","));
                  if (fulfillmentStatusValue.length) fd.append("fulfillmentStatus", fulfillmentStatusValue.join(","));
                  if (dateMinValue) fd.append("dateMin", dateMinValue);
                  if (dateMaxValue) fd.append("dateMax", dateMaxValue);
                  fd.append("direction", "prev");
                  fd.append("cursor", pageInfo.startCursor);
                  fd.append("page", (pageNumber > 1 ? pageNumber - 1 : 1).toString());
                  submit(fd, { method: "get" });
                }}
                hasNext={pageInfo?.hasNextPage}
                onNext={() => {
                  const fd = new FormData();
                  if (queryValue) fd.append("q", queryValue);
                  if (paymentStatusValue.length) fd.append("paymentStatus", paymentStatusValue.join(","));
                  if (fulfillmentStatusValue.length) fd.append("fulfillmentStatus", fulfillmentStatusValue.join(","));
                  if (dateMinValue) fd.append("dateMin", dateMinValue);
                  if (dateMaxValue) fd.append("dateMax", dateMaxValue);
                  fd.append("direction", "next");
                  fd.append("cursor", pageInfo.endCursor);
                  fd.append("page", (pageNumber + 1).toString());
                  submit(fd, { method: "get" });
                }}
              />
            </div>
          </Card>
        </Layout.Section>
      </Layout>

      <CreateOrderModal
        open={showCreateModal}
        onClose={() => setShowCreateModal(false)}
        staff={staff}
      />

      <FulfillmentWizard
        open={fulfillWizardOpen}
        onClose={closeFulfillWizard}
        orderId={fulfillTargetOrder?.id}
        orderName={fulfillTargetOrder?.name}
        carriers={carriers}
        packages={packages}
        onFulfilled={() => submit({}, { method: "get" })}
      />
    </Page>
  );
}

// ─── Step indicator ───────────────────────────────────────────────────────────

function StepIndicator({ steps, current }) {
  return (
    <div style={{ display: "flex", alignItems: "center", marginBottom: "24px" }}>
      {steps.map((label, idx) => {
        const num = idx + 1;
        const done = num < current;
        const active = num === current;
        return (
          <div key={label} style={{ display: "flex", alignItems: "center", flex: idx < steps.length - 1 ? 1 : "none" }}>
            <div style={{ display: "flex", alignItems: "center", gap: "8px", flexShrink: 0 }}>
              <div
                style={{
                  width: 28, height: 28, borderRadius: "50%",
                  display: "flex", alignItems: "center", justifyContent: "center",
                  background: done || active ? "var(--p-color-bg-fill-success)" : "var(--p-color-bg-surface-secondary)",
                  color: done || active ? "#fff" : "var(--p-color-text-subdued)",
                  fontWeight: 700, fontSize: 13, flexShrink: 0,
                }}
              >
                {done ? "✓" : num}
              </div>
              <span style={{
                fontSize: 13,
                fontWeight: active ? 600 : 400,
                color: active ? "var(--p-color-text)" : "var(--p-color-text-subdued)",
                whiteSpace: "nowrap",
              }}>
                {label}
              </span>
            </div>
            {idx < steps.length - 1 && (
              <div style={{ flex: 1, height: 1, background: "var(--p-color-border)", margin: "0 12px" }} />
            )}
          </div>
        );
      })}
    </div>
  );
}

// ─── Create Order Modal ────────────────────────────────────────────────────────

const STEPS = ["Customer", "Products", "Shipping", "Payment"];
const EMPTY_ADDRESS = {
  firstName: "", lastName: "", address1: "", address2: "",
  city: "", province: "", zip: "", countryCode: "IN", phone: "",
};

function CreateOrderModal({ open, onClose, staff }) {
  const [step, setStep] = useState(1);

  // Step 1
  const [customerQuery, setCustomerQuery] = useState("");
  const [selectedCustomer, setSelectedCustomer] = useState(null);
  const [selectedStaffId, setSelectedStaffId] = useState("");

  // Step 2
  const [productQuery, setProductQuery] = useState("");
  const [lineItems, setLineItems] = useState([]);

  // Step 3
  const [address, setAddress] = useState(EMPTY_ADDRESS);

  // Step 4
  const [gateway, setGateway] = useState("manual");
  const [paymentTerm, setPaymentTerm] = useState("full");
  const [partialAmount, setPartialAmount] = useState("");

  // Result copy state
  const [linkCopied, setLinkCopied] = useState(false);

  const customerFetcher = useFetcher();
  const productFetcher = useFetcher();
  const orderFetcher = useFetcher();

  const custTimeout = useRef(null);
  const prodTimeout = useRef(null);

  // Reset when modal opens
  useEffect(() => {
    if (open) {
      setStep(1);
      setCustomerQuery("");
      setSelectedCustomer(null);
      setSelectedStaffId("");
      setProductQuery("");
      setLineItems([]);
      setAddress(EMPTY_ADDRESS);
      setGateway("manual");
      setPaymentTerm("full");
      setPartialAmount("");
      setLinkCopied(false);
    }
  }, [open]);

  // ── Customer search ─────────────────────────────────────────────────────────
  const handleCustomerQuery = useCallback((val) => {
    setCustomerQuery(val);
    setSelectedCustomer(null);
    if (custTimeout.current) clearTimeout(custTimeout.current);
    if (val.trim().length >= 2) {
      custTimeout.current = setTimeout(() => {
        customerFetcher.load(`/app/api/customers?q=${encodeURIComponent(val)}`);
      }, 400);
    }
  }, [customerFetcher]);

  const handleSelectCustomer = useCallback((c) => {
    setSelectedCustomer(c);
    setCustomerQuery(`${c.firstName || ""} ${c.lastName || ""}`.trim());
    if (c.defaultAddress) {
      const a = c.defaultAddress;
      setAddress({
        firstName: a.firstName || c.firstName || "",
        lastName: a.lastName || c.lastName || "",
        address1: a.address1 || "",
        address2: a.address2 || "",
        city: a.city || "",
        province: a.province || "",
        zip: a.zip || "",
        countryCode: a.countryCodeV2 || "IN",
        phone: a.phone || c.phone || "",
      });
    } else {
      setAddress((prev) => ({
        ...prev,
        firstName: c.firstName || "",
        lastName: c.lastName || "",
        phone: c.phone || "",
      }));
    }
  }, []);

  // ── Product search ──────────────────────────────────────────────────────────
  const handleProductQuery = useCallback((val) => {
    setProductQuery(val);
    if (prodTimeout.current) clearTimeout(prodTimeout.current);
    if (val.trim().length >= 2) {
      prodTimeout.current = setTimeout(() => {
        productFetcher.load(`/app/api/products?q=${encodeURIComponent(val)}`);
      }, 400);
    }
  }, [productFetcher]);

  const handleAddVariant = useCallback((product, variant) => {
    setLineItems((prev) => {
      const existing = prev.find((i) => i.variantId === variant.id);
      if (existing) {
        return prev.map((i) =>
          i.variantId === variant.id ? { ...i, quantity: i.quantity + 1 } : i
        );
      }
      return [
        ...prev,
        {
          variantId: variant.id,
          productTitle: product.title,
          variantTitle: variant.title === "Default Title" ? "" : variant.title,
          price: parseFloat(variant.price),
          quantity: 1,
          image: product.featuredImage?.url || null,
        },
      ];
    });
  }, []);

  const handleQty = useCallback((variantId, delta) => {
    setLineItems((prev) =>
      prev.map((i) =>
        i.variantId === variantId
          ? { ...i, quantity: Math.max(1, i.quantity + delta) }
          : i
      )
    );
  }, []);

  const handleRemove = useCallback((variantId) => {
    setLineItems((prev) => prev.filter((i) => i.variantId !== variantId));
  }, []);

  // ── Create order ────────────────────────────────────────────────────────────
  const handleCreate = useCallback(() => {
    const fd = new FormData();
    fd.append("intent", "createOrder");
    fd.append("customerId", selectedCustomer.id);
    fd.append("customerEmail", selectedCustomer.email || "");
    fd.append("customerName", `${selectedCustomer.firstName || ""} ${selectedCustomer.lastName || ""}`.trim());
    fd.append("customerPhone", selectedCustomer.phone || "");
    fd.append("lineItems", JSON.stringify(lineItems));
    fd.append("shippingAddress", JSON.stringify(address));
    fd.append("gateway", gateway);
    fd.append("paymentTerm", paymentTerm);
    if (paymentTerm === "partial") fd.append("partialAmount", partialAmount);
    if (selectedStaffId && staff) {
      const staffMember = staff.find((s) => s.id.toString() === selectedStaffId);
      if (staffMember) fd.append("staffName", staffMember.name);
    }
    orderFetcher.submit(fd, { method: "post", action: "/app?index" });
  }, [selectedCustomer, lineItems, address, gateway, paymentTerm, partialAmount, orderFetcher, selectedStaffId, staff]);

  // ── Derived values ──────────────────────────────────────────────────────────
  const lineTotal = lineItems.reduce((s, i) => s + i.price * i.quantity, 0);
  const customers = customerFetcher.data?.customers || [];
  const products = productFetcher.data?.products || [];
  const isSubmitting = orderFetcher.state === "submitting";
  const result = orderFetcher.data;

  const canNext1 = !!selectedCustomer;
  const canNext2 = lineItems.length > 0;
  const canNext3 = !!(address.address1 && address.city && address.zip && address.countryCode);
  const canCreate =
    gateway === "manual" ||
    (gateway === "razorpay" &&
      (paymentTerm === "full" ||
        (paymentTerm === "partial" && parseFloat(partialAmount) > 0)));

  // ── Success screen ──────────────────────────────────────────────────────────
  if (result?.success) {
    return (
      <Modal
        open={open}
        onClose={onClose}
        title="Order created"
        secondaryActions={[{ content: "Close", onAction: onClose }]}
      >
        <Modal.Section>
          {result.type === "manual" ? (
            <BlockStack gap="400" inlineAlign="center">
              <div style={{ textAlign: "center" }}>
                <div style={{ fontSize: 40, marginBottom: 8 }}>✅</div>
                <Text variant="headingMd" as="h2">Order created successfully!</Text>
              </div>
              <div style={{ textAlign: "center" }}>
                <Badge tone="success" size="large">{result.orderName}</Badge>
              </div>
              <Text as="p" tone="subdued" alignment="center">
                The order has been created and marked as paid.
              </Text>
            </BlockStack>
          ) : (
            <BlockStack gap="400">
              <div style={{ textAlign: "center" }}>
                <div style={{ fontSize: 40, marginBottom: 8 }}>🔗</div>
                <Text variant="headingMd" as="h2">Draft order {result.draftOrderName} created</Text>
              </div>
              <Banner tone="info">
                Share this payment link with the customer. The order will be confirmed once payment is received.
              </Banner>
              <TextField
                label="Razorpay Payment Link"
                value={result.paymentLink}
                readOnly
                autoComplete="off"
                connectedRight={
                  <Button
                    tone={linkCopied ? "success" : undefined}
                    onClick={() => {
                      navigator.clipboard.writeText(result.paymentLink);
                      setLinkCopied(true);
                      setTimeout(() => setLinkCopied(false), 2000);
                    }}
                  >
                    {linkCopied ? "Copied!" : "Copy"}
                  </Button>
                }
              />
              <Text as="p" variant="bodySm" tone="subdued">
                Payment amount: ₹{result.paidAmount}
                {result.paidAmount !== result.totalAmount &&
                  ` (partial — full order total: ₹${result.totalAmount})`}
              </Text>
            </BlockStack>
          )}
        </Modal.Section>
      </Modal>
    );
  }

  // ── Wizard ─────────────────────────────────────────────────────────────────
  const isPrimaryDisabled =
    (step === 1 && !canNext1) ||
    (step === 2 && !canNext2) ||
    (step === 3 && !canNext3) ||
    (step === 4 && (!canCreate || isSubmitting));

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Create new order"
      size="large"
      primaryAction={{
        content: step < 4 ? "Next" : "Create order",
        onAction: step < 4 ? () => setStep((s) => s + 1) : handleCreate,
        loading: isSubmitting,
        disabled: isPrimaryDisabled,
      }}
      secondaryActions={[
        ...(step > 1 ? [{ content: "Back", onAction: () => setStep((s) => s - 1) }] : []),
        { content: "Cancel", onAction: onClose },
      ]}
    >
      <Modal.Section>
        {result?.error && (
          <div style={{ marginBottom: 16 }}>
            <Banner tone="critical" title="Could not create order">
              <p>{result.error}</p>
            </Banner>
          </div>
        )}

        <StepIndicator steps={STEPS} current={step} />

        {/* ── Step 1: Customer ─────────────────────────────────────────────── */}
        {step === 1 && (
          <BlockStack gap="400">
            <Select
              label="Assigned Staff Member"
              options={[
                { label: "Select staff (optional)", value: "" },
                ...(staff || []).map((s) => ({ label: s.name, value: s.id.toString() })),
              ]}
              value={selectedStaffId}
              onChange={setSelectedStaffId}
            />
            <Divider />
            <Text variant="headingMd" as="h3">Customer Details</Text>
            <TextField
              label="Search customer"
              placeholder="Name, email, or phone number"
              value={customerQuery}
              onChange={handleCustomerQuery}
              autoComplete="off"
              clearButton
              onClearButtonClick={() => { setCustomerQuery(""); setSelectedCustomer(null); }}
              suffix={customerFetcher.state === "loading" ? <Spinner size="small" /> : undefined}
            />

            {selectedCustomer && (
              <Card>
                <InlineStack gap="300" blockAlign="center">
                  <Avatar
                    size="md"
                    name={`${selectedCustomer.firstName || ""} ${selectedCustomer.lastName || ""}`}
                    initials={`${selectedCustomer.firstName?.[0] || ""}${selectedCustomer.lastName?.[0] || ""}`.toUpperCase() || "?"}
                  />
                  <BlockStack gap="050">
                    <Text fontWeight="semibold">
                      {`${selectedCustomer.firstName || ""} ${selectedCustomer.lastName || ""}`.trim() || "—"}
                    </Text>
                    {selectedCustomer.email && (
                      <Text tone="subdued" variant="bodySm">{selectedCustomer.email}</Text>
                    )}
                    {selectedCustomer.phone && (
                      <Text tone="subdued" variant="bodySm">{selectedCustomer.phone}</Text>
                    )}
                  </BlockStack>
                  <div style={{ marginLeft: "auto" }}>
                    <Badge tone="success">Selected</Badge>
                  </div>
                </InlineStack>
              </Card>
            )}

            {!selectedCustomer && customers.length > 0 && (
              <BlockStack gap="200">
                {customers.map((c) => (
                  <div
                    key={c.id}
                    onClick={() => handleSelectCustomer(c)}
                    style={{ cursor: "pointer" }}
                  >
                    <Box
                      padding="300"
                      background="bg-surface-secondary"
                      borderRadius="200"
                    >
                      <InlineStack gap="300" blockAlign="center">
                        <Avatar
                          size="sm"
                          name={`${c.firstName || ""} ${c.lastName || ""}`}
                          initials={`${c.firstName?.[0] || ""}${c.lastName?.[0] || ""}`.toUpperCase() || "?"}
                        />
                        <BlockStack gap="050">
                          <Text fontWeight="semibold" variant="bodySm">
                            {`${c.firstName || ""} ${c.lastName || ""}`.trim() || "—"}
                          </Text>
                          <Text tone="subdued" variant="bodySm">
                            {[c.email, c.phone].filter(Boolean).join(" · ") || "No contact info"}
                          </Text>
                        </BlockStack>
                      </InlineStack>
                    </Box>
                  </div>
                ))}
              </BlockStack>
            )}

            {customerQuery.trim().length >= 2 &&
              customers.length === 0 &&
              customerFetcher.state === "idle" && (
                <Text tone="subdued" alignment="center">No customers found for "{customerQuery}"</Text>
              )}
          </BlockStack>
        )}

        {/* ── Step 2: Products ─────────────────────────────────────────────── */}
        {step === 2 && (
          <BlockStack gap="400">
            <TextField
              label="Search products"
              placeholder="Product name or SKU"
              value={productQuery}
              onChange={handleProductQuery}
              autoComplete="off"
              clearButton
              onClearButtonClick={() => setProductQuery("")}
              suffix={productFetcher.state === "loading" ? <Spinner size="small" /> : undefined}
            />

            {products.length > 0 && (
              <BlockStack gap="200">
                <Text variant="headingSm" tone="subdued">Results</Text>
                {products.map((product) => (
                  <Card key={product.id}>
                    <BlockStack gap="300">
                      <InlineStack gap="300" blockAlign="center">
                        {product.featuredImage ? (
                          <Thumbnail
                            source={product.featuredImage.url}
                            alt={product.title}
                            size="small"
                          />
                        ) : (
                          <Box
                            width="40px"
                            minHeight="40px"
                            background="bg-surface-secondary"
                            borderRadius="100"
                          />
                        )}
                        <Text fontWeight="semibold">{product.title}</Text>
                      </InlineStack>
                      {product.variants.map((variant) => (
                        <InlineStack key={variant.id} align="space-between" blockAlign="center">
                          <Text variant="bodySm" tone="subdued">
                            {variant.title === "Default Title" ? "Default" : variant.title}
                            {" · "}₹{parseFloat(variant.price).toFixed(2)}
                          </Text>
                          <Button
                            size="slim"
                            onClick={() => handleAddVariant(product, variant)}
                            disabled={!variant.availableForSale}
                          >
                            {variant.availableForSale ? "Add" : "Unavailable"}
                          </Button>
                        </InlineStack>
                      ))}
                    </BlockStack>
                  </Card>
                ))}
              </BlockStack>
            )}

            {productQuery.trim().length >= 2 &&
              products.length === 0 &&
              productFetcher.state === "idle" && (
                <Text tone="subdued" alignment="center">No products found for "{productQuery}"</Text>
              )}

            {lineItems.length > 0 && (
              <BlockStack gap="300">
                <Divider />
                <InlineStack align="space-between" blockAlign="center">
                  <Text variant="headingSm" tone="subdued">
                    Cart — {lineItems.length} item{lineItems.length !== 1 ? "s" : ""}
                  </Text>
                  <Text variant="headingSm" fontWeight="semibold">
                    ₹{lineTotal.toFixed(2)}
                  </Text>
                </InlineStack>
                {lineItems.map((item) => (
                  <Card key={item.variantId}>
                    <InlineStack align="space-between" blockAlign="center">
                      <InlineStack gap="300" blockAlign="center">
                        {item.image && (
                          <Thumbnail source={item.image} alt={item.productTitle} size="small" />
                        )}
                        <BlockStack gap="050">
                          <Text fontWeight="semibold" variant="bodySm">{item.productTitle}</Text>
                          {item.variantTitle && (
                            <Text tone="subdued" variant="bodySm">{item.variantTitle}</Text>
                          )}
                          <Text variant="bodySm" tone="subdued">
                            ₹{item.price.toFixed(2)} × {item.quantity} = ₹{(item.price * item.quantity).toFixed(2)}
                          </Text>
                        </BlockStack>
                      </InlineStack>
                      <InlineStack gap="150" blockAlign="center">
                        <Button size="slim" onClick={() => handleQty(item.variantId, -1)}>−</Button>
                        <Text>{item.quantity}</Text>
                        <Button size="slim" onClick={() => handleQty(item.variantId, 1)}>+</Button>
                        <Button size="slim" tone="critical" onClick={() => handleRemove(item.variantId)}>
                          Remove
                        </Button>
                      </InlineStack>
                    </InlineStack>
                  </Card>
                ))}
              </BlockStack>
            )}
          </BlockStack>
        )}

        {/* ── Step 3: Shipping Address ──────────────────────────────────────── */}
        {step === 3 && (
          <BlockStack gap="400">
            <Text variant="headingSm">Shipping Address</Text>
            <FormLayout>
              <FormLayout.Group>
                <TextField
                  label="First Name"
                  value={address.firstName}
                  onChange={(v) => setAddress((a) => ({ ...a, firstName: v }))}
                  autoComplete="off"
                />
                <TextField
                  label="Last Name"
                  value={address.lastName}
                  onChange={(v) => setAddress((a) => ({ ...a, lastName: v }))}
                  autoComplete="off"
                />
              </FormLayout.Group>
              <TextField
                label="Address Line 1"
                value={address.address1}
                onChange={(v) => setAddress((a) => ({ ...a, address1: v }))}
                autoComplete="off"
              />
              <TextField
                label="Address Line 2"
                value={address.address2}
                onChange={(v) => setAddress((a) => ({ ...a, address2: v }))}
                autoComplete="off"
              />
              <FormLayout.Group>
                <TextField
                  label="City"
                  value={address.city}
                  onChange={(v) => setAddress((a) => ({ ...a, city: v }))}
                  autoComplete="off"
                />
                <TextField
                  label="State / Province"
                  value={address.province}
                  onChange={(v) => setAddress((a) => ({ ...a, province: v }))}
                  autoComplete="off"
                />
              </FormLayout.Group>
              <FormLayout.Group>
                <TextField
                  label="ZIP / Postal Code"
                  value={address.zip}
                  onChange={(v) => setAddress((a) => ({ ...a, zip: v }))}
                  autoComplete="off"
                />
                <TextField
                  label="Country Code"
                  value={address.countryCode}
                  onChange={(v) => setAddress((a) => ({ ...a, countryCode: v.toUpperCase().slice(0, 2) }))}
                  placeholder="IN"
                  autoComplete="off"
                  helpText="2-letter ISO code (e.g. IN, US, GB)"
                />
              </FormLayout.Group>
              <TextField
                label="Phone"
                value={address.phone}
                onChange={(v) => setAddress((a) => ({ ...a, phone: v }))}
                type="tel"
                autoComplete="off"
              />
            </FormLayout>
          </BlockStack>
        )}

        {/* ── Step 4: Payment ───────────────────────────────────────────────── */}
        {step === 4 && (
          <BlockStack gap="400">
            <Text variant="headingSm">Payment</Text>
            <Select
              label="Payment Gateway"
              options={[
                { label: "Manual — mark as paid immediately", value: "manual" },
                { label: "Razorpay — generate a payment link", value: "razorpay" },
              ]}
              value={gateway}
              onChange={(v) => { setGateway(v); setPaymentTerm("full"); setPartialAmount(""); }}
            />

            {gateway === "manual" && (
              <Banner tone="info">
                A Shopify order will be created immediately and marked as paid.{" "}
                Total: <strong>₹{lineTotal.toFixed(2)}</strong>
              </Banner>
            )}

            {gateway === "razorpay" && (
              <>
                <Select
                  label="Payment Term"
                  options={[
                    { label: "Full payment", value: "full" },
                    { label: "Partial payment", value: "partial" },
                  ]}
                  value={paymentTerm}
                  onChange={setPaymentTerm}
                />

                {paymentTerm === "full" && (
                  <Banner tone="info">
                    A Razorpay payment link for{" "}
                    <strong>₹{lineTotal.toFixed(2)}</strong> will be generated.
                    The Shopify order will be confirmed once payment is received.
                  </Banner>
                )}

                {paymentTerm === "partial" && (
                  <>
                    <TextField
                      label="Partial Amount (₹)"
                      type="number"
                      value={partialAmount}
                      onChange={setPartialAmount}
                      prefix="₹"
                      autoComplete="off"
                      helpText={`Full order total is ₹${lineTotal.toFixed(2)}`}
                    />
                    {parseFloat(partialAmount) > 0 && (
                      <Banner tone="warning">
                        A Razorpay payment link for{" "}
                        <strong>₹{parseFloat(partialAmount).toFixed(2)}</strong>{" "}
                        will be generated (partial of ₹{lineTotal.toFixed(2)}).
                      </Banner>
                    )}
                  </>
                )}
              </>
            )}

            <Divider />
            <BlockStack gap="200">
              <Text variant="headingSm" tone="subdued">Order Summary</Text>
              {lineItems.map((item) => (
                <InlineStack key={item.variantId} align="space-between">
                  <Text variant="bodySm">
                    {item.productTitle}
                    {item.variantTitle ? ` — ${item.variantTitle}` : ""} × {item.quantity}
                  </Text>
                  <Text variant="bodySm">₹{(item.price * item.quantity).toFixed(2)}</Text>
                </InlineStack>
              ))}
              <Divider />
              <InlineStack align="space-between">
                <Text fontWeight="semibold">Total</Text>
                <Text fontWeight="semibold">₹{lineTotal.toFixed(2)}</Text>
              </InlineStack>
            </BlockStack>
          </BlockStack>
        )}
      </Modal.Section>
    </Modal>
  );
}
