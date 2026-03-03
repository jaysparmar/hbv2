import { json } from "@remix-run/node";
import { useLoaderData, useSubmit, useNavigation, useSearchParams } from "@remix-run/react";
import { Page, Layout, Card, IndexTable, Text, Badge, Link, InlineStack, IndexFilters, useSetIndexFiltersMode, useIndexResourceState, ChoiceList } from "@shopify/polaris";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { useState, useCallback, useRef, useEffect } from "react";

export const loader = async ({ request }) => {
    await authenticate.admin(request);
    const url = new URL(request.url);
    const q = url.searchParams.get("q") || "";
    const dispatchStatusParam = url.searchParams.get("dispatchStatus") || "";

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

    const parcels = await prisma.parcel.findMany({
        where,
        orderBy: { createdAt: "desc" },
    });
    return json({ parcels, q, dispatchStatusParam });
    return json({ parcels });
};

export default function ParcelsMaster() {
    const { parcels, q, dispatchStatusParam } = useLoaderData();
    const submit = useSubmit();
    const navigation = useNavigation();

    const isLoading = navigation.state === "loading";

    const { mode, setMode } = useSetIndexFiltersMode();
    const [queryValue, setQueryValue] = useState(q);
    const [dispatchStatusValue, setDispatchStatusValue] = useState(dispatchStatusParam ? dispatchStatusParam.split(",") : []);
    const timeoutId = useRef(null);

    useEffect(() => {
        setQueryValue(q);
        setDispatchStatusValue(dispatchStatusParam ? dispatchStatusParam.split(",") : []);
    }, [q, dispatchStatusParam]);

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

    const rowMarkup = parcels.map((parcel, index) => {
        // Construct the tracking link
        let trackingLink = null;
        if (parcel.carrierId) {
            // We could hypothetically fetch the tracking link here or build it on the fly if we want,
            // but the awbNumber is stored. Since we don't have tracking URL directly in the record,
            // we can just display the awbNumber. We might need to join Carrier table, or we can just 
            // use awbNumber. The user mentioned they want to quickly see Fulfillments and details.
        }

        return (
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
                    <Text as="span" tone="subdued">
                        {new Date(parcel.createdAt).toLocaleDateString()}
                    </Text>
                </IndexTable.Cell>
            </IndexTable.Row>
        );
    });

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
                                { title: "Created At" },
                            ]}
                            selectable={false}
                            loading={isLoading}
                        >
                            {rowMarkup}
                        </IndexTable>
                    </Card>
                </Layout.Section>
            </Layout>
        </Page>
    );
}
