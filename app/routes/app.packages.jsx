import { useState, useCallback, useRef, useEffect } from "react";
import { json } from "@remix-run/node";
import { useLoaderData, useSubmit, useActionData, useNavigation, useSearchParams } from "@remix-run/react";
import { Page, Layout, Card, IndexTable, Text, Button, Modal, TextField, BlockStack, InlineStack, RangeSlider, IndexFilters, useSetIndexFiltersMode, useIndexResourceState } from "@shopify/polaris";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";

export const loader = async ({ request }) => {
    await authenticate.admin(request);
    const url = new URL(request.url);
    const q = url.searchParams.get("q") || "";

    const where = q ? { name: { contains: q } } : {};
    // SQLite string operations can be tricky with case-sensitivity, but Prisma's `contains` on SQLite defaults to case-insensitive or sensitive depending on DB collation.
    // In Prisma schema for SQLite we can't do mode: 'insensitive' typically. Let's just use `contains`.

    const packages = await prisma.package.findMany({
        where: q ? { name: { contains: q } } : undefined,
        orderBy: { updatedAt: "desc" },
    });
    return json({ packages, q });
};

export const action = async ({ request }) => {
    await authenticate.admin(request);
    const formData = await request.formData();
    const actionType = formData.get("actionType");

    if (actionType === "create") {
        await prisma.package.create({
            data: {
                name: formData.get("name"),
                length: parseFloat(formData.get("length")) || 0,
                width: parseFloat(formData.get("width")) || 0,
                height: parseFloat(formData.get("height")) || 0,
                weight: parseFloat(formData.get("weight")) || 0,
                valueOfRepayment: formData.get("valueOfRepayment")?.toString() || null,
            },
        });
        return json({ status: "success", message: "Package created" });
    }

    if (actionType === "update") {
        const id = parseInt(formData.get("id"), 10);
        await prisma.package.update({
            where: { id },
            data: {
                name: formData.get("name"),
                length: parseFloat(formData.get("length")) || 0,
                width: parseFloat(formData.get("width")) || 0,
                height: parseFloat(formData.get("height")) || 0,
                weight: parseFloat(formData.get("weight")) || 0,
                valueOfRepayment: formData.get("valueOfRepayment")?.toString() || null,
            },
        });
        return json({ status: "success", message: "Package updated" });
    }

    if (actionType === "delete") {
        const id = parseInt(formData.get("id"), 10);
        await prisma.package.delete({ where: { id } });
        return json({ status: "success", message: "Package deleted" });
    }

    return null;
};

export default function PackageMaster() {
    const { packages, q } = useLoaderData();
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

    const resourceName = { singular: "package", plural: "packages" };
    const { selectedResources, allResourcesSelected, handleSelectionChange } = useIndexResourceState(packages);

    const [isModalOpen, setIsModalOpen] = useState(false);
    const [editingPackage, setEditingPackage] = useState(null);

    const [name, setName] = useState("");
    const [length, setLength] = useState("");
    const [width, setWidth] = useState("");
    const [height, setHeight] = useState("");
    const [weight, setWeight] = useState("");
    const [valueOfRepayment, setValueOfRepayment] = useState("");

    const isSubmitting = navigation.state === "submitting";

    const resetForm = useCallback(() => {
        setName("");
        setLength("");
        setWidth("");
        setHeight("");
        setWeight("");
        setValueOfRepayment("");
        setEditingPackage(null);
    }, []);

    const handleChange = useCallback(() => {
        setIsModalOpen(!isModalOpen);
        if (isModalOpen) resetForm(); // Reset when closing
    }, [isModalOpen, resetForm]);

    const handleEdit = useCallback((pkg) => {
        setEditingPackage(pkg);
        setName(pkg.name);
        setLength(pkg.length.toString());
        setWidth(pkg.width.toString());
        setHeight(pkg.height.toString());
        setWeight(pkg.weight.toString());
        setValueOfRepayment(pkg.valueOfRepayment || "");
        setIsModalOpen(true);
    }, []);

    const handleDelete = useCallback((id) => {
        if (confirm("Are you sure you want to delete this package?")) {
            submit({ actionType: "delete", id: id.toString() }, { method: "post" });
        }
    }, [submit]);

    const handleSave = useCallback(() => {
        const formData = {
            actionType: editingPackage ? "update" : "create",
            name,
            length,
            width,
            height,
            weight,
            valueOfRepayment
        };
        if (editingPackage) {
            formData.id = editingPackage.id;
        }
        submit(formData, { method: "post" });
        handleChange();
    }, [editingPackage, name, length, width, height, weight, valueOfRepayment, submit, handleChange]);


    const rowMarkup = packages.map((pkg, index) => (
        <IndexTable.Row id={pkg.id} key={pkg.id} position={index}>
            <IndexTable.Cell>
                <Text variant="bodyMd" fontWeight="bold" as="span">{pkg.name}</Text>
            </IndexTable.Cell>
            <IndexTable.Cell>{pkg.length} cm</IndexTable.Cell>
            <IndexTable.Cell>{pkg.width} cm</IndexTable.Cell>
            <IndexTable.Cell>{pkg.height} cm</IndexTable.Cell>
            <IndexTable.Cell>{pkg.weight} kg</IndexTable.Cell>
            <IndexTable.Cell>{pkg.valueOfRepayment || "-"}</IndexTable.Cell>
            <IndexTable.Cell>
                <InlineStack gap="200">
                    <Button size="micro" onClick={() => handleEdit(pkg)}>Edit</Button>
                    <Button size="micro" tone="critical" onClick={() => handleDelete(pkg.id)}>Delete</Button>
                </InlineStack>
            </IndexTable.Cell>
        </IndexTable.Row>
    ));

    return (
        <Page
            title="Packages Master"
            primaryAction={{
                content: "Add package",
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
                            queryPlaceholder="Search packages by name"
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
                            itemCount={packages.length}
                            selectedItemsCount={
                                allResourcesSelected ? "All" : selectedResources.length
                            }
                            onSelectionChange={handleSelectionChange}
                            headings={[
                                { title: "Name" },
                                { title: "Length (cm)" },
                                { title: "Width (cm)" },
                                { title: "Height (cm)" },
                                { title: "Weight (kg)" },
                                { title: "Value of Repayment" },
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
                title={editingPackage ? "Edit package" : "Add package"}
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
                            label="Package name"
                            value={name}
                            onChange={setName}
                            autoComplete="off"
                        />
                        <InlineStack gap="400">
                            <TextField
                                type="number"
                                label="Length (cm)"
                                value={length}
                                onChange={setLength}
                                autoComplete="off"
                            />
                            <TextField
                                type="number"
                                label="Width (cm)"
                                value={width}
                                onChange={setWidth}
                                autoComplete="off"
                            />
                        </InlineStack>
                        <InlineStack gap="400">
                            <TextField
                                type="number"
                                label="Height (cm)"
                                value={height}
                                onChange={setHeight}
                                autoComplete="off"
                            />
                            <TextField
                                type="number"
                                label="Weight (kg)"
                                value={weight}
                                onChange={setWeight}
                                autoComplete="off"
                            />
                            <TextField
                                type="text"
                                label="Value Of Repayment"
                                value={valueOfRepayment}
                                onChange={setValueOfRepayment}
                                autoComplete="off"
                            />
                        </InlineStack>
                    </BlockStack>
                </Modal.Section>
            </Modal>
        </Page>
    );
}
