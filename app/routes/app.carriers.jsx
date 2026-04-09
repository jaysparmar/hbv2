import { useState, useCallback, useRef, useEffect } from "react";
import { json } from "@remix-run/node";
import { useLoaderData, useSubmit, useActionData, useNavigation, useSearchParams } from "@remix-run/react";
import { Page, Layout, Card, IndexTable, Text, Button, Modal, TextField, BlockStack, InlineStack, Checkbox, Badge, IndexFilters, useSetIndexFiltersMode, useIndexResourceState, ChoiceList } from "@shopify/polaris";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";

export const loader = async ({ request }) => {
    await authenticate.admin(request);
    const url = new URL(request.url);
    const q = url.searchParams.get("q") || "";
    const statusParams = url.searchParams.get("status") || "";

    const AND = [];
    if (q) {
        AND.push({
            OR: [
                { name: { contains: q } },
                { trackingUrl: { contains: q } }
            ]
        });
    }

    if (statusParams) {
        const statuses = statusParams.split(",");
        const isActives = [];
        if (statuses.includes("active")) isActives.push(true);
        if (statuses.includes("disabled")) isActives.push(false);
        if (isActives.length > 0) {
            AND.push({ isActive: { in: isActives } });
        }
    }

    const where = AND.length > 0 ? { AND } : undefined;

    const carriers = await prisma.carrier.findMany({
        where,
        orderBy: { updatedAt: "desc" },
    });
    return json({ carriers, q, statusParam: statusParams });
};

export const action = async ({ request }) => {
    await authenticate.admin(request);
    const formData = await request.formData();
    const actionType = formData.get("actionType");

    if (actionType === "create") {
        await prisma.carrier.create({
            data: {
                name: formData.get("name"),
                trackingUrl: formData.get("trackingUrl"),
                isActive: formData.get("isActive") === "true",
            },
        });
        return json({ status: "success", message: "Carrier created" });
    }

    if (actionType === "update") {
        const id = parseInt(formData.get("id"), 10);
        await prisma.carrier.update({
            where: { id },
            data: {
                name: formData.get("name"),
                trackingUrl: formData.get("trackingUrl"),
                isActive: formData.get("isActive") === "true",
            },
        });
        return json({ status: "success", message: "Carrier updated" });
    }

    if (actionType === "delete") {
        const id = parseInt(formData.get("id"), 10);
        await prisma.carrier.delete({ where: { id } });
        return json({ status: "success", message: "Carrier deleted" });
    }

    return null;
};

export default function CarrierMaster() {
    const { carriers, q, statusParam } = useLoaderData();
    const submit = useSubmit();
    const navigation = useNavigation();

    const isLoading = navigation.state === "loading";

    const { mode, setMode } = useSetIndexFiltersMode();
    const [queryValue, setQueryValue] = useState(q);
    const [statusFilterValue, setStatusFilterValue] = useState(statusParam ? statusParam.split(",") : []);
    const timeoutId = useRef(null);

    useEffect(() => {
        setQueryValue(q);
        setStatusFilterValue(statusParam ? statusParam.split(",") : []);
    }, [q, statusParam]);

    const handleFiltersQueryChange = useCallback(
        (value) => {
            setQueryValue(value);
            if (timeoutId.current) clearTimeout(timeoutId.current);
            timeoutId.current = setTimeout(() => {
                const formData = new FormData();
                if (value) formData.append("q", value);
                if (statusFilterValue.length) formData.append("status", statusFilterValue.join(","));
                submit(formData, { method: "get" });
            }, 500);
        },
        [statusFilterValue, submit]
    );

    const handleStatusFilterChange = useCallback((value) => {
        setStatusFilterValue(value);
        const formData = new FormData();
        if (queryValue) formData.append("q", queryValue);
        if (value.length) formData.append("status", value.join(","));
        submit(formData, { method: "get" });
    }, [queryValue, submit]);

    const handleFiltersClearAll = useCallback(() => {
        setQueryValue("");
        setStatusFilterValue([]);
        submit({}, { method: "get" });
    }, [submit]);

    const filters = [
        {
            key: "status",
            label: "Status",
            filter: (
                <ChoiceList
                    title="Status"
                    titleHidden
                    choices={[
                        { label: "Active", value: "active" },
                        { label: "Disabled", value: "disabled" },
                    ]}
                    selected={statusFilterValue}
                    onChange={handleStatusFilterChange}
                    allowMultiple
                />
            ),
            shortcut: true,
        }
    ];

    const appliedFilters = [];
    if (statusFilterValue.length > 0) {
        appliedFilters.push({
            key: "status",
            label: `Status: ${statusFilterValue.join(", ")}`,
            onRemove: () => {
                setStatusFilterValue([]);
                const formData = new FormData();
                if (queryValue) formData.append("q", queryValue);
                submit(formData, { method: "get" });
            },
        });
    }

    const resourceName = { singular: "carrier", plural: "carriers" };
    const { selectedResources, allResourcesSelected, handleSelectionChange } = useIndexResourceState(carriers);

    const [isModalOpen, setIsModalOpen] = useState(false);
    const [editingCarrier, setEditingCarrier] = useState(null);

    const [name, setName] = useState("");
    const [trackingUrl, setTrackingUrl] = useState("");
    const [isActive, setIsActive] = useState(true);

    const isSubmitting = navigation.state === "submitting";

    const resetForm = useCallback(() => {
        setName("");
        setTrackingUrl("");
        setIsActive(true);
        setEditingCarrier(null);
    }, []);

    const handleChange = useCallback(() => {
        setIsModalOpen(!isModalOpen);
        if (isModalOpen) resetForm(); // Reset when closing
    }, [isModalOpen, resetForm]);

    const handleEdit = useCallback((carrier) => {
        setEditingCarrier(carrier);
        setName(carrier.name);
        setTrackingUrl(carrier.trackingUrl);
        setIsActive(carrier.isActive);
        setIsModalOpen(true);
    }, []);

    const handleDelete = useCallback((id) => {
        if (confirm("Are you sure you want to delete this carrier?")) {
            submit({ actionType: "delete", id: id.toString() }, { method: "post" });
        }
    }, [submit]);

    const handleSave = useCallback(() => {
        const formData = {
            actionType: editingCarrier ? "update" : "create",
            name,
            trackingUrl,
            isActive: isActive.toString()
        };
        if (editingCarrier) {
            formData.id = editingCarrier.id;
        }
        submit(formData, { method: "post" });
        handleChange();
    }, [editingCarrier, name, trackingUrl, isActive, submit, handleChange]);


    const rowMarkup = carriers.map((carrier, index) => (
        <IndexTable.Row id={carrier.id} key={carrier.id} position={index}>
            <IndexTable.Cell>
                <Text variant="bodyMd" fontWeight="bold" as="span">{carrier.name}</Text>
            </IndexTable.Cell>
            <IndexTable.Cell>
                <Text as="span">{carrier.trackingUrl}</Text>
            </IndexTable.Cell>
            <IndexTable.Cell>
                {carrier.isActive ? (
                    <Badge tone="success">Active</Badge>
                ) : (
                    <Badge tone="critical">Disabled</Badge>
                )}
            </IndexTable.Cell>
            <IndexTable.Cell>
                <InlineStack gap="200">
                    <Button size="micro" onClick={() => handleEdit(carrier)}>Edit</Button>
                    <Button size="micro" tone="critical" onClick={() => handleDelete(carrier.id)}>Delete</Button>
                </InlineStack>
            </IndexTable.Cell>
        </IndexTable.Row>
    ));

    return (
        <Page
            title="Carriers Master"
            primaryAction={{
                content: "Add carrier",
                onAction: handleChange,
            }}
        >
            <Layout>
                <Layout.Section>
                    <Card padding="0">
                        <IndexFilters
                            sortOptions={[]}
                            sortSelected={[]}
                            onSort={() => { }}
                            queryValue={queryValue}
                            queryPlaceholder="Search carriers by name or URL"
                            onQueryChange={handleFiltersQueryChange}
                            onQueryClear={() => {
                                setQueryValue("");
                                const formData = new FormData();
                                if (statusFilterValue.length) formData.append("status", statusFilterValue.join(","));
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
                            itemCount={carriers.length}
                            selectedItemsCount={
                                allResourcesSelected ? "All" : selectedResources.length
                            }
                            onSelectionChange={handleSelectionChange}
                            headings={[
                                { title: "Name" },
                                { title: "Tracking URL" },
                                { title: "Status" },
                                { title: "Actions" },
                            ]}
                            selectable={false}
                            loading={isLoading}
                        >
                            {rowMarkup}
                        </IndexTable>
                    </Card>
                </Layout.Section>
            </Layout>

            <Modal
                open={isModalOpen}
                onClose={handleChange}
                title={editingCarrier ? "Edit carrier" : "Add carrier"}
                primaryAction={{
                    content: "Save",
                    onAction: handleSave,
                    loading: isSubmitting,
                }}
                secondaryActions={[
                    {
                        content: "Cancel",
                        onAction: handleChange,
                    },
                ]}
            >
                <Modal.Section>
                    <BlockStack gap="400">
                        <TextField
                            label="Carrier name"
                            value={name}
                            onChange={setName}
                            autoComplete="off"
                        />
                        <TextField
                            label="Tracking URL template"
                            helpText="Use {awb_number} as a placeholder, e.g., https://example.com/track/{awb_number}"
                            value={trackingUrl}
                            onChange={setTrackingUrl}
                            autoComplete="off"
                        />
                        <Checkbox
                            label="Active"
                            checked={isActive}
                            onChange={setIsActive}
                        />
                    </BlockStack>
                </Modal.Section>
            </Modal>
        </Page>
    );
}
