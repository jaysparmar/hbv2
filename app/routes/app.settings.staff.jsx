import {
    Page,
    Layout,
    Card,
    Text,
    Button,
    BlockStack,
    IndexTable,
    Modal,
    FormLayout,
    TextField,
    InlineStack,
    Avatar,
} from "@shopify/polaris";
import { PlusIcon, DeleteIcon, EditIcon } from "@shopify/polaris-icons";
import { useState, useCallback } from "react";
import { useLoaderData, useSubmit, useNavigation } from "@remix-run/react";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";

export const loader = async ({ request }) => {
    await authenticate.admin(request);
    const staff = await prisma.staffMember.findMany({
        orderBy: { createdAt: "desc" },
    });
    return { staff };
};

export const action = async ({ request }) => {
    await authenticate.admin(request);
    const formData = await request.formData();
    const intent = formData.get("intent");

    if (intent === "create") {
        await prisma.staffMember.create({
            data: {
                name: formData.get("name"),
                designation: formData.get("designation") || "",
                image: formData.get("image") || "",
                email: formData.get("email") || "",
                phone: formData.get("phone") || "",
            },
        });
        return { success: true };
    }

    if (intent === "update") {
        await prisma.staffMember.update({
            where: { id: parseInt(formData.get("id"), 10) },
            data: {
                name: formData.get("name"),
                designation: formData.get("designation") || "",
                image: formData.get("image") || "",
                email: formData.get("email") || "",
                phone: formData.get("phone") || "",
            },
        });
        return { success: true };
    }

    if (intent === "delete") {
        await prisma.staffMember.delete({
            where: { id: parseInt(formData.get("id"), 10) },
        });
        return { success: true };
    }

    return { error: "Unknown intent" };
};

export default function StaffSettingsPage() {
    const { staff } = useLoaderData();
    const submit = useSubmit();
    const navigation = useNavigation();
    const isSubmitting = navigation.state === "submitting";

    const [modalActive, setModalActive] = useState(false);
    const [editingStaff, setEditingStaff] = useState(null);

    // Form states
    const [name, setName] = useState("");
    const [designation, setDesignation] = useState("");
    const [email, setEmail] = useState("");
    const [phone, setPhone] = useState("");
    const [image, setImage] = useState("");

    const handleModalClose = useCallback(() => {
        setModalActive(false);
        setEditingStaff(null);
        setName("");
        setDesignation("");
        setEmail("");
        setPhone("");
        setImage("");
    }, []);

    const handleEdit = useCallback((staffMember) => {
        setEditingStaff(staffMember);
        setName(staffMember.name || "");
        setDesignation(staffMember.designation || "");
        setEmail(staffMember.email || "");
        setPhone(staffMember.phone || "");
        setImage(staffMember.image || "");
        setModalActive(true);
    }, []);

    const handleCreateNew = useCallback(() => {
        handleModalClose();
        setModalActive(true);
    }, [handleModalClose]);

    const handleSave = useCallback(() => {
        const formData = new FormData();
        formData.append("intent", editingStaff ? "update" : "create");
        if (editingStaff) {
            formData.append("id", editingStaff.id);
        }
        formData.append("name", name);
        formData.append("designation", designation);
        formData.append("email", email);
        formData.append("phone", phone);
        formData.append("image", image);

        submit(formData, { method: "post" });
        handleModalClose();
    }, [editingStaff, name, designation, email, phone, image, submit, handleModalClose]);

    const handleDelete = useCallback((id) => {
        if (confirm("Are you sure you want to delete this staff member?")) {
            const formData = new FormData();
            formData.append("intent", "delete");
            formData.append("id", id);
            submit(formData, { method: "post" });
        }
    }, [submit]);

    const resourceName = { singular: "staff member", plural: "staff members" };

    const rowMarkup = staff.map((member, index) => (
        <IndexTable.Row id={member.id} key={member.id} position={index}>
            <IndexTable.Cell>
                <InlineStack gap="300" blockAlign="center">
                    <Avatar size="md" source={member.image || null} initials={member.name.charAt(0)} />
                    <BlockStack>
                        <Text variant="bodyMd" fontWeight="bold" as="span">{member.name}</Text>
                        {member.designation && (
                            <Text variant="bodySm" tone="subdued" as="span">{member.designation}</Text>
                        )}
                    </BlockStack>
                </InlineStack>
            </IndexTable.Cell>
            <IndexTable.Cell>{member.email || "—"}</IndexTable.Cell>
            <IndexTable.Cell>{member.phone || "—"}</IndexTable.Cell>
            <IndexTable.Cell>
                <InlineStack gap="200" align="end">
                    <Button icon={EditIcon} onClick={() => handleEdit(member)} variant="tertiary" />
                    <Button icon={DeleteIcon} tone="critical" onClick={() => handleDelete(member.id)} variant="tertiary" />
                </InlineStack>
            </IndexTable.Cell>
        </IndexTable.Row>
    ));

    return (
        <Page
            backAction={{ content: "Settings", url: "/app/settings" }}
            title="Staff Management"
            subtitle="Add and manage staff members to assign them to orders."
            primaryAction={{
                content: "Add Staff Member",
                icon: PlusIcon,
                onAction: handleCreateNew,
            }}
        >
            <Layout>
                <Layout.Section>
                    <Card padding="0">
                        <IndexTable
                            resourceName={resourceName}
                            itemCount={staff.length}
                            selectable={false}
                            headings={[
                                { title: "Staff Member" },
                                { title: "Email" },
                                { title: "Phone" },
                                { title: "Actions", alignment: "end" },
                            ]}
                            loading={isSubmitting}
                        >
                            {rowMarkup}
                        </IndexTable>
                    </Card>
                </Layout.Section>
            </Layout>

            <Modal
                open={modalActive}
                onClose={handleModalClose}
                title={editingStaff ? "Edit Staff Member" : "Add Staff Member"}
                primaryAction={{
                    content: "Save",
                    onAction: handleSave,
                    disabled: !name.trim(),
                }}
                secondaryActions={[
                    {
                        content: "Cancel",
                        onAction: handleModalClose,
                    },
                ]}
            >
                <Modal.Section>
                    <FormLayout>
                        <TextField
                            label="Name"
                            value={name}
                            onChange={setName}
                            autoComplete="off"
                            requiredIndicator
                        />
                        <TextField
                            label="Designation"
                            value={designation}
                            onChange={setDesignation}
                            autoComplete="off"
                            placeholder="e.g. Sales Representative"
                        />
                        <FormLayout.Group>
                            <TextField
                                label="Email"
                                type="email"
                                value={email}
                                onChange={setEmail}
                                autoComplete="email"
                            />
                            <TextField
                                label="Phone"
                                type="tel"
                                value={phone}
                                onChange={setPhone}
                                autoComplete="tel"
                            />
                        </FormLayout.Group>
                        <TextField
                            label="Image URL"
                            value={image}
                            onChange={setImage}
                            autoComplete="off"
                            placeholder="https://example.com/image.jpg"
                            helpText="Optional link to a profile picture."
                        />
                    </FormLayout>
                </Modal.Section>
            </Modal>
        </Page>
    );
}
