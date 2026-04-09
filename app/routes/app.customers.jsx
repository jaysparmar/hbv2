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
    TextField,
    Pagination,
    Button,
    InlineStack,
    Avatar,
} from "@shopify/polaris";
import { authenticate } from "../shopify.server";
import { useState, useCallback, useEffect, useRef } from "react";
import { json } from "@remix-run/node";

export const loader = async ({ request }) => {
    const { admin } = await authenticate.admin(request);
    const url = new URL(request.url);

    const q = url.searchParams.get("q") || "";
    const accountState = url.searchParams.get("accountState") || "";
    const emailVerified = url.searchParams.get("emailVerified") || "";
    const hasOrders = url.searchParams.get("hasOrders") || "";
    const dateMin = url.searchParams.get("dateMin") || "";
    const dateMax = url.searchParams.get("dateMax") || "";
    const cursor = url.searchParams.get("cursor") || "";
    const direction = url.searchParams.get("direction") || "next";

    // Build Shopify query string
    const queryParts = [];
    if (q) queryParts.push(q);
    if (accountState) {
        accountState.split(",").forEach((s) => queryParts.push(`state:${s}`));
    }
    if (emailVerified === "yes") queryParts.push("verified_email:true");
    if (emailVerified === "no") queryParts.push("verified_email:false");
    if (hasOrders === "yes") queryParts.push("orders_count:>0");
    if (hasOrders === "no") queryParts.push("orders_count:0");
    if (dateMin) queryParts.push(`created_at:>=${dateMin}`);
    if (dateMax) queryParts.push(`created_at:<=${dateMax}`);

    const queryStr = queryParts.join(" ") || null;

    const paginationArgs = cursor
        ? direction === "next"
            ? `first: 20, after: "${cursor}"`
            : `last: 20, before: "${cursor}"`
        : `first: 20`;

    const response = await admin.graphql(
        `#graphql
      query getCustomers($query: String) {
        customers(${paginationArgs}, sortKey: CREATED_AT, reverse: true, query: $query) {
          pageInfo {
            hasNextPage
            hasPreviousPage
            startCursor
            endCursor
          }
          edges {
            node {
              id
              firstName
              lastName
              email
              phone
              numberOfOrders
              amountSpent {
                amount
                currencyCode
              }
              createdAt
              verifiedEmail
              state
              defaultAddress {
                city
                province
                country
              }
            }
          }
        }
      }`,
        { variables: { query: queryStr } }
    );

    const responseJson = await response.json();
    const customersData = responseJson?.data?.customers || { edges: [], pageInfo: {} };
    const customers = customersData.edges.map((edge) => edge.node);
    const pageInfo = customersData.pageInfo;

    const shopResponse = await admin.graphql(`#graphql
    query { shop { myshopifyDomain } }
  `);
    const shopJson = await shopResponse.json();
    const shopDomain = shopJson?.data?.shop?.myshopifyDomain || "";

    return json({ customers, pageInfo, q, accountState, emailVerified, hasOrders, dateMin, dateMax, shopDomain });
};

export default function CustomersPage() {
    const { customers, pageInfo, q, accountState, emailVerified, hasOrders, dateMin, dateMax, shopDomain } = useLoaderData();
    const navigate = useNavigate();
    const submit = useSubmit();
    const navigation = useNavigation();

    const isLoading = navigation.state === "loading";

    const { mode, setMode } = useSetIndexFiltersMode();

    const [queryValue, setQueryValue] = useState(q);
    const [accountStateValue, setAccountStateValue] = useState(accountState ? accountState.split(",") : []);
    const [emailVerifiedValue, setEmailVerifiedValue] = useState(emailVerified ? [emailVerified] : []);
    const [hasOrdersValue, setHasOrdersValue] = useState(hasOrders ? [hasOrders] : []);
    const [dateMinValue, setDateMinValue] = useState(dateMin);
    const [dateMaxValue, setDateMaxValue] = useState(dateMax);

    const timeoutId = useRef(null);
    const [searchParams] = useSearchParams();
    const pageNumber = parseInt(searchParams.get("page") || "1", 10);

    useEffect(() => {
        setQueryValue(q);
        setAccountStateValue(accountState ? accountState.split(",") : []);
        setEmailVerifiedValue(emailVerified ? [emailVerified] : []);
        setHasOrdersValue(hasOrders ? [hasOrders] : []);
        setDateMinValue(dateMin);
        setDateMaxValue(dateMax);
    }, [q, accountState, emailVerified, hasOrders, dateMin, dateMax]);

    // Helper to build and submit filter form data
    const buildAndSubmit = useCallback((overrides = {}) => {
        const vals = {
            q: queryValue,
            accountState: accountStateValue.join(","),
            emailVerified: emailVerifiedValue[0] || "",
            hasOrders: hasOrdersValue[0] || "",
            dateMin: dateMinValue,
            dateMax: dateMaxValue,
            ...overrides,
        };
        const formData = new FormData();
        if (vals.q) formData.append("q", vals.q);
        if (vals.accountState) formData.append("accountState", vals.accountState);
        if (vals.emailVerified) formData.append("emailVerified", vals.emailVerified);
        if (vals.hasOrders) formData.append("hasOrders", vals.hasOrders);
        if (vals.dateMin) formData.append("dateMin", vals.dateMin);
        if (vals.dateMax) formData.append("dateMax", vals.dateMax);
        submit(formData, { method: "get" });
    }, [queryValue, accountStateValue, emailVerifiedValue, hasOrdersValue, dateMinValue, dateMaxValue, submit]);

    const handleFiltersQueryChange = useCallback((value) => {
        setQueryValue(value);
        if (timeoutId.current) clearTimeout(timeoutId.current);
        timeoutId.current = setTimeout(() => {
            buildAndSubmit({ q: value });
        }, 500);
    }, [buildAndSubmit]);

    const handleAccountStateChange = useCallback((value) => {
        setAccountStateValue(value);
        buildAndSubmit({ accountState: value.join(",") });
    }, [buildAndSubmit]);

    const handleEmailVerifiedChange = useCallback((value) => {
        setEmailVerifiedValue(value);
        buildAndSubmit({ emailVerified: value[0] || "" });
    }, [buildAndSubmit]);

    const handleHasOrdersChange = useCallback((value) => {
        setHasOrdersValue(value);
        buildAndSubmit({ hasOrders: value[0] || "" });
    }, [buildAndSubmit]);

    const handleDateMinChange = useCallback((value) => {
        setDateMinValue(value);
        buildAndSubmit({ dateMin: value });
    }, [buildAndSubmit]);

    const handleDateMaxChange = useCallback((value) => {
        setDateMaxValue(value);
        buildAndSubmit({ dateMax: value });
    }, [buildAndSubmit]);

    const handleFiltersClearAll = useCallback(() => {
        setQueryValue("");
        setAccountStateValue([]);
        setEmailVerifiedValue([]);
        setHasOrdersValue([]);
        setDateMinValue("");
        setDateMaxValue("");
        submit({}, { method: "get" });
    }, [submit]);

    const filters = [
        {
            key: "accountState",
            label: "Account Status",
            filter: (
                <ChoiceList
                    title="Account Status"
                    titleHidden
                    choices={[
                        { label: "Enabled", value: "enabled" },
                        { label: "Disabled", value: "disabled" },
                        { label: "Invited", value: "invited" },
                        { label: "Declined", value: "declined" },
                    ]}
                    selected={accountStateValue}
                    onChange={handleAccountStateChange}
                    allowMultiple
                />
            ),
            shortcut: true,
        },
        {
            key: "emailVerified",
            label: "Email Verified",
            filter: (
                <ChoiceList
                    title="Email Verified"
                    titleHidden
                    choices={[
                        { label: "Verified", value: "yes" },
                        { label: "Not verified", value: "no" },
                    ]}
                    selected={emailVerifiedValue}
                    onChange={handleEmailVerifiedChange}
                />
            ),
            shortcut: true,
        },
        {
            key: "hasOrders",
            label: "Has Orders",
            filter: (
                <ChoiceList
                    title="Has Orders"
                    titleHidden
                    choices={[
                        { label: "Has placed orders", value: "yes" },
                        { label: "No orders yet", value: "no" },
                    ]}
                    selected={hasOrdersValue}
                    onChange={handleHasOrdersChange}
                />
            ),
            shortcut: true,
        },
        {
            key: "dateRange",
            label: "Date joined",
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
    if (accountStateValue.length > 0) {
        appliedFilters.push({
            key: "accountState",
            label: `Status: ${accountStateValue.join(", ")}`,
            onRemove: () => { setAccountStateValue([]); buildAndSubmit({ accountState: "" }); },
        });
    }
    if (emailVerifiedValue.length > 0) {
        appliedFilters.push({
            key: "emailVerified",
            label: emailVerifiedValue[0] === "yes" ? "Email: Verified" : "Email: Not verified",
            onRemove: () => { setEmailVerifiedValue([]); buildAndSubmit({ emailVerified: "" }); },
        });
    }
    if (hasOrdersValue.length > 0) {
        appliedFilters.push({
            key: "hasOrders",
            label: hasOrdersValue[0] === "yes" ? "Has orders" : "No orders",
            onRemove: () => { setHasOrdersValue([]); buildAndSubmit({ hasOrders: "" }); },
        });
    }
    if (dateMinValue || dateMaxValue) {
        appliedFilters.push({
            key: "dateRange",
            label: `Joined: ${dateMinValue || "—"} to ${dateMaxValue || "—"}`,
            onRemove: () => { setDateMinValue(""); setDateMaxValue(""); buildAndSubmit({ dateMin: "", dateMax: "" }); },
        });
    }

    const resourceName = { singular: "customer", plural: "customers" };
    const { selectedResources, allResourcesSelected, handleSelectionChange } =
        useIndexResourceState(customers);

    const getStateBadge = (state) => {
        switch ((state || "").toUpperCase()) {
            case "ENABLED": return <Badge tone="success">Enabled</Badge>;
            case "DISABLED": return <Badge tone="critical">Disabled</Badge>;
            case "INVITED": return <Badge tone="info">Invited</Badge>;
            case "DECLINED": return <Badge tone="warning">Declined</Badge>;
            default: return <Badge>{state || "—"}</Badge>;
        }
    };

    const rowMarkup = customers.map(
        ({ id, firstName, lastName, email, phone, numberOfOrders, amountSpent, createdAt, state, verifiedEmail, defaultAddress }, index) => {
            const customerId = id.split("/").pop();
            const fullName = `${firstName || ""} ${lastName || ""}`.trim() || "—";
            const date = new Date(createdAt).toLocaleDateString();
            const location = defaultAddress
                ? [defaultAddress.city, defaultAddress.province, defaultAddress.country].filter(Boolean).join(", ")
                : "—";
            const spent = amountSpent
                ? new Intl.NumberFormat("en-US", { style: "currency", currency: amountSpent.currencyCode }).format(amountSpent.amount)
                : "—";

            return (
                <IndexTable.Row
                    id={id}
                    key={id}
                    selected={selectedResources.includes(id)}
                    position={index}
                    onClick={() => navigate(`/app/customers/${customerId}`)}
                >
                    <IndexTable.Cell>
                        <InlineStack gap="300" blockAlign="center">
                            <Avatar
                                size="sm"
                                name={fullName}
                                initials={`${firstName?.[0] || ""}${lastName?.[0] || ""}`.toUpperCase() || "?"}
                            />
                            <Text variant="bodyMd" fontWeight="bold" as="span">{fullName}</Text>
                        </InlineStack>
                    </IndexTable.Cell>
                    <IndexTable.Cell>
                        <InlineStack gap="100" blockAlign="center">
                            <Text as="span" tone="subdued">{email || "—"}</Text>
                            {email && <Badge tone={verifiedEmail ? "success" : "warning"}>{verifiedEmail ? "Verified" : "Unverified"}</Badge>}
                        </InlineStack>
                    </IndexTable.Cell>
                    <IndexTable.Cell><Text as="span" tone="subdued">{phone || "—"}</Text></IndexTable.Cell>
                    <IndexTable.Cell>{location}</IndexTable.Cell>
                    <IndexTable.Cell><Text as="span">{numberOfOrders ?? 0} orders</Text></IndexTable.Cell>
                    <IndexTable.Cell><Text as="span">{spent}</Text></IndexTable.Cell>
                    <IndexTable.Cell>{getStateBadge(state)}</IndexTable.Cell>
                    <IndexTable.Cell><Text as="span" tone="subdued">{date}</Text></IndexTable.Cell>
                </IndexTable.Row>
            );
        }
    );

    const createCustomerUrl = shopDomain
        ? `https://admin.shopify.com/store/${shopDomain.replace(".myshopify.com", "")}/customers/new`
        : "#";

    return (
        <Page
            fullWidth
            title="Customers"
            subtitle="All customers from your Shopify store."
            primaryAction={
                <Button variant="primary" url={createCustomerUrl} external target="_blank">
                    Create customer
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
                            queryPlaceholder="Search by name, email, or phone"
                            onQueryChange={handleFiltersQueryChange}
                            onQueryClear={() => { setQueryValue(""); buildAndSubmit({ q: "" }); }}
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
                            itemCount={customers.length}
                            selectedItemsCount={allResourcesSelected ? "All" : selectedResources.length}
                            onSelectionChange={handleSelectionChange}
                            headings={[
                                { title: "Customer" },
                                { title: "Email" },
                                { title: "Phone" },
                                { title: "Location" },
                                { title: "Orders" },
                                { title: "Amount Spent" },
                                { title: "Account Status" },
                                { title: "Joined" },
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
                                    const formData = new FormData();
                                    if (queryValue) formData.append("q", queryValue);
                                    if (accountStateValue.length) formData.append("accountState", accountStateValue.join(","));
                                    if (emailVerifiedValue[0]) formData.append("emailVerified", emailVerifiedValue[0]);
                                    if (hasOrdersValue[0]) formData.append("hasOrders", hasOrdersValue[0]);
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
                                    if (accountStateValue.length) formData.append("accountState", accountStateValue.join(","));
                                    if (emailVerifiedValue[0]) formData.append("emailVerified", emailVerifiedValue[0]);
                                    if (hasOrdersValue[0]) formData.append("hasOrders", hasOrdersValue[0]);
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
