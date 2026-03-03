import { useState, useCallback } from "react";
import { json } from "@remix-run/node";
import { useLoaderData, useSubmit, useActionData, useNavigation } from "@remix-run/react";
import { Page, Layout, Card, IndexTable, Text, Button, Modal, TextField, BlockStack, InlineStack, RangeSlider } from "@shopify/polaris";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";

export const loader = async ({ request }) => {
    await authenticate.admin(request);
    const packages = await prisma.package.findMany({
        orderBy: { updatedAt: "desc" },
    });
    return json({ packages });
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
    const { packages } = useLoaderData();
    const submit = useSubmit();
    const navigation = useNavigation();

    const [isModalOpen, setIsModalOpen] = useState(false);
    const [editingPackage, setEditingPackage] = useState(null);

    const [name, setName] = useState("");
    const [length, setLength] = useState("");
    const [width, setWidth] = useState("");
    const [height, setHeight] = useState("");
    const [weight, setWeight] = useState("");

    const isSubmitting = navigation.state === "submitting";

    const resetForm = useCallback(() => {
        setName("");
        setLength("");
        setWidth("");
        setHeight("");
        setWeight("");
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
            weight
        };
        if (editingPackage) {
            formData.id = editingPackage.id;
        }
        submit(formData, { method: "post" });
        handleChange();
    }, [editingPackage, name, length, width, height, weight, submit, handleChange]);


    const rowMarkup = packages.map((pkg, index) => (
        <IndexTable.Row id={pkg.id} key={pkg.id} position={index}>
            <IndexTable.Cell>
                <Text variant="bodyMd" fontWeight="bold" as="span">{pkg.name}</Text>
            </IndexTable.Cell>
            <IndexTable.Cell>{pkg.length} cm</IndexTable.Cell>
            <IndexTable.Cell>{pkg.width} cm</IndexTable.Cell>
            <IndexTable.Cell>{pkg.height} cm</IndexTable.Cell>
            <IndexTable.Cell>{pkg.weight} kg</IndexTable.Cell>
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
                        <IndexTable
                            resourceName={{ singular: "package", plural: "packages" }}
                            itemCount={packages.length}
                            headings={[
                                { title: "Name" },
                                { title: "Length (cm)" },
                                { title: "Width (cm)" },
                                { title: "Height (cm)" },
                                { title: "Weight (kg)" },
                                { title: "Actions" },
                            ]}
                            selectable={false}
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
                        </InlineStack>
                    </BlockStack>
                </Modal.Section>
            </Modal>
        </Page>
    );
}
