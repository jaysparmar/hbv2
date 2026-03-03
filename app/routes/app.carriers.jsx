import { useState, useCallback } from "react";
import { json } from "@remix-run/node";
import { useLoaderData, useSubmit, useActionData, useNavigation } from "@remix-run/react";
import { Page, Layout, Card, IndexTable, Text, Button, Modal, TextField, BlockStack, InlineStack, Checkbox, Badge } from "@shopify/polaris";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";

export const loader = async ({ request }) => {
    await authenticate.admin(request);
    const carriers = await prisma.carrier.findMany({
        orderBy: { updatedAt: "desc" },
    });
    return json({ carriers });
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
    const { carriers } = useLoaderData();
    const submit = useSubmit();
    const navigation = useNavigation();

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
                        <IndexTable
                            resourceName={{ singular: "carrier", plural: "carriers" }}
                            itemCount={carriers.length}
                            headings={[
                                { title: "Name" },
                                { title: "Tracking URL" },
                                { title: "Status" },
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
