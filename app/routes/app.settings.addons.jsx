import { useState, useCallback, useRef, useEffect } from "react";
import { json } from "@remix-run/node";
import { useLoaderData, useSubmit, useNavigation, Link } from "@remix-run/react";
import { 
    Page, 
    Layout, 
    Card, 
    IndexTable, 
    Text, 
    Button, 
    Modal, 
    TextField, 
    BlockStack, 
    InlineStack, 
    IndexFilters, 
    useSetIndexFiltersMode, 
    useIndexResourceState,
    Badge,
    Checkbox
} from "@shopify/polaris";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";

export const loader = async ({ request }) => {
    await authenticate.admin(request);
    const url = new URL(request.url);
    const q = url.searchParams.get("q") || "";

    const addons = await prisma.addonProduct.findMany({
        where: q ? { name: { contains: q } } : undefined,
        orderBy: { updatedAt: "desc" },
    });
    return json({ addons, q });
};

export const action = async ({ request }) => {
    await authenticate.admin(request);
    const formData = await request.formData();
    const actionType = formData.get("actionType");

    if (actionType === "create") {
        await prisma.addonProduct.create({
            data: {
                name: formData.get("name"),
                stock: parseInt(formData.get("stock"), 10) || 0,
                isActive: formData.get("isActive") === "true",
            },
        });
        return json({ status: "success", message: "Add-on created" });
    }

    if (actionType === "update") {
        const id = parseInt(formData.get("id"), 10);
        await prisma.addonProduct.update({
            where: { id },
            data: {
                name: formData.get("name"),
                stock: parseInt(formData.get("stock"), 10) || 0,
                isActive: formData.get("isActive") === "true",
            },
        });
        return json({ status: "success", message: "Add-on updated" });
    }

    if (actionType === "delete") {
        const id = parseInt(formData.get("id"), 10);
        await prisma.addonProduct.delete({ where: { id } });
        return json({ status: "success", message: "Add-on deleted" });
    }

    return null;
};

export default function AddonsSettingsPage() {
    const { addons, q } = useLoaderData();
    const submit = useSubmit();
    const navigation = useNavigation();

    const isLoading = navigation.state === "loading";

    const { mode, setMode } = useSetIndexFiltersMode();
    const [queryValue, setQueryValue] = useState(q);
    const timeoutId = useRef(null);

    useEffect(() => {
        setQueryValue(q);
    }, [q]);

    const handleFiltersQueryChange = useCallback(
        (value) => {
            setQueryValue(value);
            if (timeoutId.current) clearTimeout(timeoutId.current);
            timeoutId.current = setTimeout(() => {
                const formData = new FormData();
                if (value) formData.append("q", value);
                submit(formData, { method: "get" });
            }, 500);
        },
        [submit]
    );

    const handleFiltersClearAll = useCallback(() => {
        setQueryValue("");
        submit({}, { method: "get" });
    }, [submit]);

    const resourceName = { singular: "add-on", plural: "add-ons" };
    const { selectedResources, allResourcesSelected, handleSelectionChange } = useIndexResourceState(addons);

    const [isModalOpen, setIsModalOpen] = useState(false);
    const [editingAddon, setEditingAddon] = useState(null);

    const [name, setName] = useState("");
    const [stock, setStock] = useState("0");
    const [isActive, setIsActive] = useState(true);

    const isSubmitting = navigation.state === "submitting";

    const resetForm = useCallback(() => {
        setName("");
        setStock("0");
        setIsActive(true);
        setEditingAddon(null);
    }, []);

    const handleChange = useCallback(() => {
        setIsModalOpen(!isModalOpen);
        if (isModalOpen) resetForm(); 
    }, [isModalOpen, resetForm]);

    const handleEdit = useCallback((addon) => {
        setEditingAddon(addon);
        setName(addon.name);
        setStock(addon.stock.toString());
        setIsActive(addon.isActive);
        setIsModalOpen(true);
    }, []);

    const handleDelete = useCallback((id) => {
        if (confirm("Are you sure you want to delete this add-on?")) {
            submit({ actionType: "delete", id: id.toString() }, { method: "post" });
        }
    }, [submit]);

    const handleSave = useCallback(() => {
        const formData = {
            actionType: editingAddon ? "update" : "create",
            name,
            stock,
            isActive: isActive.toString(),
        };
        if (editingAddon) {
            formData.id = editingAddon.id;
        }
        submit(formData, { method: "post" });
        handleChange();
    }, [editingAddon, name, stock, isActive, submit, handleChange]);

    const rowMarkup = addons.map((addon, index) => (
        <IndexTable.Row id={addon.id.toString()} key={addon.id} position={index}>
            <IndexTable.Cell>
                <Text variant="bodyMd" fontWeight="bold" as="span">{addon.name}</Text>
            </IndexTable.Cell>
            <IndexTable.Cell>
                {addon.stock}
            </IndexTable.Cell>
            <IndexTable.Cell>
                <Badge tone={addon.isActive ? "success" : "critical"}>
                    {addon.isActive ? "Active" : "Inactive"}
                </Badge>
            </IndexTable.Cell>
            <IndexTable.Cell>
                <InlineStack gap="200">
                    <Button size="micro" onClick={() => handleEdit(addon)}>Edit</Button>
                    <Button size="micro" tone="critical" onClick={() => handleDelete(addon.id)}>Delete</Button>
                </InlineStack>
            </IndexTable.Cell>
        </IndexTable.Row>
    ));

    return (
        <Page
            backAction={{ content: 'Settings', url: '/app/settings' }}
            title="Add-ons Management"
            subtitle="Manage your promotional items and their stock levels."
            primaryAction={{
                content: "Add new item",
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
                            queryPlaceholder="Search add-ons by name"
                            onQueryChange={handleFiltersQueryChange}
                            onQueryClear={() => {
                                setQueryValue("");
                                submit({}, { method: "get" });
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
                            filters={[]}
                            appliedFilters={[]}
                            onClearAll={handleFiltersClearAll}
                            mode={mode}
                            setMode={setMode}
                        />
                        <IndexTable
                            resourceName={resourceName}
                            itemCount={addons.length}
                            selectedItemsCount={
                                allResourcesSelected ? "All" : selectedResources.length
                            }
                            onSelectionChange={handleSelectionChange}
                            headings={[
                                { title: "Name" },
                                { title: "Stock Level" },
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
                title={editingAddon ? "Edit Add-on" : "Create Add-on"}
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
                            label="Add-on name"
                            value={name}
                            onChange={setName}
                            autoComplete="off"
                        />
                        <TextField
                            type="number"
                            label="Stock Quantity"
                            value={stock}
                            onChange={setStock}
                            autoComplete="off"
                        />
                        <Checkbox
                            label="Is Active?"
                            checked={isActive}
                            onChange={setIsActive}
                        />
                    </BlockStack>
                </Modal.Section>
            </Modal>
        </Page>
    );
}
