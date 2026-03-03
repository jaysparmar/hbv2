import { useLoaderData, useNavigate, useSubmit, useNavigation, useSearchParams } from "@remix-run/react";
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
  BlockStack,
  TextField,
  Pagination,
} from "@shopify/polaris";
import { authenticate } from "../shopify.server";
import { useState, useCallback, useEffect } from "react";

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
          pageInfo {
            hasNextPage
            hasPreviousPage
            startCursor
            endCursor
          }
          edges {
            node {
              id
              name
              createdAt
              displayFinancialStatus
              displayFulfillmentStatus
              totalPriceSet {
                shopMoney {
                  amount
                  currencyCode
                }
              }
              customer {
                firstName
                lastName
              }
            }
          }
        }
      }`,
    {
      variables: { query: queryStr || null }
    }
  );

  const responseJson = await response.json();
  const ordersData = responseJson?.data?.orders || { edges: [], pageInfo: {} };
  const orders = ordersData.edges.map((edge) => edge.node);
  const pageInfo = ordersData.pageInfo;

  return { orders, pageInfo, q, paymentStatus, fulfillmentStatus, dateMin, dateMax };
};

export default function Index() {
  const { orders, pageInfo, q, paymentStatus, fulfillmentStatus, dateMin, dateMax } = useLoaderData();
  const navigate = useNavigate();
  const submit = useSubmit();
  const navigation = useNavigation();

  const isLoading = navigation.state === "loading";

  const { mode, setMode } = useSetIndexFiltersMode();

  const [queryValue, setQueryValue] = useState(q);
  const [paymentStatusValue, setPaymentStatusValue] = useState(paymentStatus ? paymentStatus.split(",") : []);
  const [fulfillmentStatusValue, setFulfillmentStatusValue] = useState(fulfillmentStatus ? fulfillmentStatus.split(",") : []);
  const [dateMinValue, setDateMinValue] = useState(dateMin);
  const [dateMaxValue, setDateMaxValue] = useState(dateMax);

  useEffect(() => {
    setQueryValue(q);
    setPaymentStatusValue(paymentStatus ? paymentStatus.split(",") : []);
    setFulfillmentStatusValue(fulfillmentStatus ? fulfillmentStatus.split(",") : []);
    setDateMinValue(dateMin);
    setDateMaxValue(dateMax);
  }, [q, paymentStatus, fulfillmentStatus, dateMin, dateMax]);

  const handleFiltersQueryChange = useCallback(
    (value) => setQueryValue(value),
    []
  );

  const handlePaymentStatusChange = useCallback(
    (value) => {
      setPaymentStatusValue(value);
      const formData = new FormData();
      if (queryValue) formData.append("q", queryValue);
      if (value.length) formData.append("paymentStatus", value.join(","));
      if (fulfillmentStatusValue.length) formData.append("fulfillmentStatus", fulfillmentStatusValue.join(","));
      if (dateMinValue) formData.append("dateMin", dateMinValue);
      if (dateMaxValue) formData.append("dateMax", dateMaxValue);
      submit(formData, { method: "get" });
    },
    [queryValue, fulfillmentStatusValue, dateMinValue, dateMaxValue, submit]
  );

  const handleFulfillmentStatusChange = useCallback(
    (value) => {
      setFulfillmentStatusValue(value);
      const formData = new FormData();
      if (queryValue) formData.append("q", queryValue);
      if (paymentStatusValue.length) formData.append("paymentStatus", paymentStatusValue.join(","));
      if (value.length) formData.append("fulfillmentStatus", value.join(","));
      if (dateMinValue) formData.append("dateMin", dateMinValue);
      if (dateMaxValue) formData.append("dateMax", dateMaxValue);
      submit(formData, { method: "get" });
    },
    [queryValue, paymentStatusValue, dateMinValue, dateMaxValue, submit]
  );

  const handleDateMinChange = useCallback((value) => {
    setDateMinValue(value);
    const formData = new FormData();
    if (queryValue) formData.append("q", queryValue);
    if (paymentStatusValue.length) formData.append("paymentStatus", paymentStatusValue.join(","));
    if (fulfillmentStatusValue.length) formData.append("fulfillmentStatus", fulfillmentStatusValue.join(","));
    if (value) formData.append("dateMin", value);
    if (dateMaxValue) formData.append("dateMax", dateMaxValue);
    submit(formData, { method: "get", replace: true });
  }, [queryValue, paymentStatusValue, fulfillmentStatusValue, dateMaxValue, submit]);

  const handleDateMaxChange = useCallback((value) => {
    setDateMaxValue(value);
    const formData = new FormData();
    if (queryValue) formData.append("q", queryValue);
    if (paymentStatusValue.length) formData.append("paymentStatus", paymentStatusValue.join(","));
    if (fulfillmentStatusValue.length) formData.append("fulfillmentStatus", fulfillmentStatusValue.join(","));
    if (dateMinValue) formData.append("dateMin", dateMinValue);
    if (value) formData.append("dateMax", value);
    submit(formData, { method: "get", replace: true });
  }, [queryValue, paymentStatusValue, fulfillmentStatusValue, dateMinValue, submit]);

  const applyFilters = useCallback(() => {
    const formData = new FormData();
    if (queryValue) formData.append("q", queryValue);
    if (paymentStatusValue.length) formData.append("paymentStatus", paymentStatusValue.join(","));
    if (fulfillmentStatusValue.length) formData.append("fulfillmentStatus", fulfillmentStatusValue.join(","));
    if (dateMinValue) formData.append("dateMin", dateMinValue);
    if (dateMaxValue) formData.append("dateMax", dateMaxValue);

    submit(formData, { method: "get" });
  }, [queryValue, paymentStatusValue, fulfillmentStatusValue, dateMinValue, dateMaxValue, submit]);

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
  if (paymentStatusValue && paymentStatusValue.length > 0) {
    appliedFilters.push({
      key: "paymentStatus",
      label: `Payment: ${paymentStatusValue.join(", ")}`,
      onRemove: () => {
        setPaymentStatusValue([]);
        const formData = new FormData();
        if (queryValue) formData.append("q", queryValue);
        if (fulfillmentStatusValue.length) formData.append("fulfillmentStatus", fulfillmentStatusValue.join(","));
        if (dateMinValue) formData.append("dateMin", dateMinValue);
        if (dateMaxValue) formData.append("dateMax", dateMaxValue);
        submit(formData, { method: "get" });
      },
    });
  }
  if (fulfillmentStatusValue && fulfillmentStatusValue.length > 0) {
    appliedFilters.push({
      key: "fulfillmentStatus",
      label: `Fulfillment: ${fulfillmentStatusValue.join(", ")}`,
      onRemove: () => {
        setFulfillmentStatusValue([]);
        const formData = new FormData();
        if (queryValue) formData.append("q", queryValue);
        if (paymentStatusValue.length) formData.append("paymentStatus", paymentStatusValue.join(","));
        if (dateMinValue) formData.append("dateMin", dateMinValue);
        if (dateMaxValue) formData.append("dateMax", dateMaxValue);
        submit(formData, { method: "get" });
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
        const formData = new FormData();
        if (queryValue) formData.append("q", queryValue);
        if (paymentStatusValue.length) formData.append("paymentStatus", paymentStatusValue.join(","));
        if (fulfillmentStatusValue.length) formData.append("fulfillmentStatus", fulfillmentStatusValue.join(","));
        submit(formData, { method: "get" });
      },
    });
  }

  const handleSearchSubmit = () => {
    applyFilters();
  };

  const resourceName = {
    singular: "order",
    plural: "orders",
  };

  const { selectedResources, allResourcesSelected, handleSelectionChange } =
    useIndexResourceState(orders);

  const rowMarkup = orders.map(
    (
      {
        id,
        name,
        createdAt,
        displayFinancialStatus,
        displayFulfillmentStatus,
        totalPriceSet,
        customer,
      },
      index
    ) => {
      const orderId = id.split("/").pop();
      const customerName = customer
        ? `${customer.firstName || ""} ${customer.lastName || ""}`.trim()
        : "No customer";

      const date = new Date(createdAt).toLocaleDateString();
      const price = new Intl.NumberFormat("en-US", {
        style: "currency",
        currency: totalPriceSet.shopMoney.currencyCode,
      }).format(totalPriceSet.shopMoney.amount);

      return (
        <IndexTable.Row
          id={id}
          key={id}
          selected={selectedResources.includes(id)}
          position={index}
          onClick={() => navigate(`/app/orders/${orderId}`)}
        >
          <IndexTable.Cell>
            <Text variant="bodyMd" fontWeight="bold" as="span">
              {name}
            </Text>
          </IndexTable.Cell>
          <IndexTable.Cell>{date}</IndexTable.Cell>
          <IndexTable.Cell>{customerName}</IndexTable.Cell>
          <IndexTable.Cell>{price}</IndexTable.Cell>
          <IndexTable.Cell>
            <Badge
              tone={
                displayFinancialStatus === "PAID"
                  ? "success"
                  : displayFinancialStatus === "PENDING"
                    ? "warning"
                    : "new"
              }
            >
              {displayFinancialStatus || "UNKNOWN"}
            </Badge>
          </IndexTable.Cell>
          <IndexTable.Cell>
            <Badge
              tone={
                displayFulfillmentStatus === "FULFILLED"
                  ? "success"
                  : displayFulfillmentStatus === "UNFULFILLED"
                    ? "attention"
                    : "new"
              }
            >
              {displayFulfillmentStatus || "UNFULFILLED"}
            </Badge>
          </IndexTable.Cell>
        </IndexTable.Row>
      );
    }
  );

  const [searchParams] = useSearchParams();
  const pageNumber = parseInt(searchParams.get("page") || "1", 10);

  return (
    <Page fullWidth title="Orders">
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
                const formData = new FormData();
                if (paymentStatusValue.length) formData.append("paymentStatus", paymentStatusValue.join(","));
                if (fulfillmentStatusValue.length) formData.append("fulfillmentStatus", fulfillmentStatusValue.join(","));
                if (dateMinValue) formData.append("dateMin", dateMinValue);
                if (dateMaxValue) formData.append("dateMax", dateMaxValue);
                submit(formData, { method: "get" });
              }}
              onQuerySubmit={handleSearchSubmit}
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
              itemCount={orders.length}
              selectedItemsCount={
                allResourcesSelected ? "All" : selectedResources.length
              }
              onSelectionChange={handleSelectionChange}
              headings={[
                { title: "Order" },
                { title: "Date" },
                { title: "Customer" },
                { title: "Total" },
                { title: "Payment Status" },
                { title: "Fulfillment Status" },
              ]}
              selectable={false}
              loading={isLoading}
            >
              {rowMarkup}
            </IndexTable>
            <div style={{ display: 'flex', justifyContent: 'center', padding: '16px' }}>
              <Pagination
                label={`Page ${pageNumber}`}
                hasPrevious={pageInfo?.hasPreviousPage}
                onPrevious={() => {
                  const formData = new FormData();
                  if (queryValue) formData.append("q", queryValue);
                  if (paymentStatusValue.length) formData.append("paymentStatus", paymentStatusValue.join(","));
                  if (fulfillmentStatusValue.length) formData.append("fulfillmentStatus", fulfillmentStatusValue.join(","));
                  if (dateMinValue) formData.append("dateMin", dateMinValue);
                  if (dateMaxValue) formData.append("dateMax", dateMaxValue);
                  formData.append("direction", "prev");
                  formData.append("cursor", pageInfo.startCursor);
                  formData.append("page", (pageNumber > 1 ? pageNumber - 1 : 1).toString());
                  submit(formData, { method: "get" });
                }}
                hasNext={pageInfo?.hasNextPage}
                onNext={() => {
                  const formData = new FormData();
                  if (queryValue) formData.append("q", queryValue);
                  if (paymentStatusValue.length) formData.append("paymentStatus", paymentStatusValue.join(","));
                  if (fulfillmentStatusValue.length) formData.append("fulfillmentStatus", fulfillmentStatusValue.join(","));
                  if (dateMinValue) formData.append("dateMin", dateMinValue);
                  if (dateMaxValue) formData.append("dateMax", dateMaxValue);
                  formData.append("direction", "next");
                  formData.append("cursor", pageInfo.endCursor);
                  formData.append("page", (pageNumber + 1).toString());
                  submit(formData, { method: "get" });
                }}
              />
            </div>
          </Card>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
