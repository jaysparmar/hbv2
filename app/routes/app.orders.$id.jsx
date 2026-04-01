import { useState, useCallback } from "react";
import { json } from "@remix-run/node";
import {
    useLoaderData,
    useSubmit,
    useActionData,
    useNavigation,
} from "@remix-run/react";
import {
    Page,
    Layout,
    Card,
    BlockStack,
    Text,
    Badge,
    Grid,
    TextField,
    Button,
    List,
    InlineStack,
    Box,
    Modal,
    Select,
    FormLayout,
    Banner,
    Divider,
} from "@shopify/polaris";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import FulfillmentWizard from "../components/FulfillmentWizard";
import { printLabel } from "../utils/printLabel";
import { printInvoice } from "../utils/printInvoice";

export const loader = async ({ request, params }) => {
    const { admin } = await authenticate.admin(request);
    const orderId = `gid://shopify/Order/${params.id}`;

    const response = await admin.graphql(
        `#graphql
      query getOrder($id: ID!) {
        order(id: $id) {
          id
          name
          createdAt
          note
          tags
          displayFinancialStatus
          displayFulfillmentStatus
          totalPriceSet {
            shopMoney {
              amount
              currencyCode
            }
          }
          totalOutstandingSet {
            shopMoney {
              amount
              currencyCode
            }
          }
          customer {
            firstName
            lastName
            defaultEmailAddress { emailAddress }
            defaultPhoneNumber { phoneNumber }
          }
          shippingAddress {
            address1
            address2
            city
            province
            zip
            country
            phone
          }
          lineItems(first: 50) {
            edges {
              node {
                id
                title
                quantity
                originalTotalSet {
                  shopMoney {
                    amount
                    currencyCode
                  }
                }
              }
            }
          }
          fulfillmentOrders(first: 10) {
            edges {
              node {
                id
                status
                supportedActions {
                  action
                }
                lineItems(first: 50) {
                  edges {
                    node {
                      id
                      totalQuantity
                      remainingQuantity
                      lineItem {
                        title
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }`,
        {
            variables: {
                id: orderId,
            },
        }
    );

    const shopResponse = await admin.graphql(`#graphql
      query {
        shop {
          name
          billingAddress {
            address1
            address2
            city
            province
            zip
            country
            phone
          }
        }
      }
    `);
    const shopJson = await shopResponse.json();
    const shop = shopJson.data.shop;

    const responseJson = await response.json();
    const order = responseJson.data.order;

    const packages = await prisma.package.findMany({ orderBy: { name: "asc" } });
    const carriers = await prisma.carrier.findMany({
        where: { isActive: true },
        orderBy: { name: "asc" },
    });
    const addons = await prisma.addonProduct.findMany({
        where: { isActive: true, stock: { gt: 0 } },
        orderBy: { name: "asc" },
    });

    const parcels = await prisma.parcel.findMany({
        where: { orderId },
        orderBy: { createdAt: "desc" },
        include: { addons: { include: { addon: true } } },
    });

    // Load print settings
    const PRINT_SETTING_KEYS = [
        "label_header", "label_bnpl_line1", "label_bnpl_line2", "label_biller_id",
        "label_from_name", "label_from_address1", "label_from_address2",
        "label_from_city", "label_from_province", "label_from_zip", "label_from_phone",
        "invoice_company_name", "invoice_title", "invoice_gstin",
        "invoice_footer", "invoice_terms",
        "invoice_from_address1", "invoice_from_address2",
        "invoice_from_city", "invoice_from_province", "invoice_from_zip",
        "invoice_from_phone", "invoice_from_email", "invoice_signature",
    ];
    const settingRows = await prisma.setting.findMany({ where: { key: { in: PRINT_SETTING_KEYS } } });
    const printSettings = {};
    settingRows.forEach(r => { printSettings[r.key] = r.value; });

    return json({ order, packages, carriers, addons, parcels, shop, printSettings });
};

export const action = async ({ request, params }) => {
    const { admin } = await authenticate.admin(request);
    const formData = await request.formData();
    const actionType = formData.get("actionType");
    const orderId = `gid://shopify/Order/${params.id}`;

    let errors = [];

    if (actionType === "updateNote") {
        const note = formData.get("note");
        const response = await admin.graphql(
            `#graphql
      mutation orderUpdate($input: OrderInput!) {
        orderUpdate(input: $input) {
          order {
            id
            note
          }
          userErrors {
            field
            message
          }
        }
      }`,
            {
                variables: {
                    input: {
                        id: orderId,
                        note: note,
                    },
                },
            }
        );
        const result = await response.json();
        if (result.data?.orderUpdate?.userErrors?.length > 0) {
            errors = result.data.orderUpdate.userErrors;
        }
    } else if (actionType === "addTag") {
        const tags = formData.get("tags").split(",");
        const response = await admin.graphql(
            `#graphql
      mutation tagsAdd($id: ID!, $tags: [String!]!) {
        tagsAdd(id: $id, tags: $tags) {
          userErrors {
            field
            message
          }
        }
      }`,
            {
                variables: {
                    id: orderId,
                    tags: tags,
                },
            }
        );
        const result = await response.json();
        if (result.data?.tagsAdd?.userErrors?.length > 0) {
            errors = result.data.tagsAdd.userErrors;
        }
    } else if (actionType === "removeTag") {
        const tags = formData.get("tags").split(",");
        const response = await admin.graphql(
            `#graphql
      mutation tagsRemove($id: ID!, $tags: [String!]!) {
        tagsRemove(id: $id, tags: $tags) {
          userErrors {
            field
            message
          }
        }
      }`,
            {
                variables: {
                    id: orderId,
                    tags: tags,
                },
            }
        );
        const result = await response.json();
        if (result.data?.tagsRemove?.userErrors?.length > 0) {
            errors = result.data.tagsRemove.userErrors;
        }
    } else if (actionType === "markPaid") {
        const response = await admin.graphql(
            `#graphql
      mutation orderMarkAsPaid($input: OrderMarkAsPaidInput!) {
        orderMarkAsPaid(input: $input) {
          order {
            id
            displayFinancialStatus
          }
          userErrors {
            field
            message
          }
        }
      }`,
            {
                variables: {
                    input: {
                        id: orderId,
                    },
                },
            }
        );
        const result = await response.json();
        if (result.data?.orderMarkAsPaid?.userErrors?.length > 0) {
            errors = result.data.orderMarkAsPaid.userErrors;
        }
    } else if (actionType === "deleteParcel") {
        const parcelId = parseInt(formData.get("parcelId"), 10);
        const parcel = await prisma.parcel.findUnique({ where: { id: parcelId }, include: { addons: true } });

        if (!parcel) {
            errors = [{ message: "Parcel not found." }];
        } else if (parcel.dispatchmentId !== null) {
            errors = [{ message: "Cannot delete: this parcel is linked to a dispatch. Remove it from the dispatch first." }];
        } else {
            // Cancel the Shopify fulfillment
            const cancelResponse = await admin.graphql(
                `#graphql
        mutation fulfillmentCancel($id: ID!) {
          fulfillmentCancel(id: $id) {
            fulfillment {
              id
              status
            }
            userErrors {
              field
              message
            }
          }
        }`,
                { variables: { id: parcel.fulfillmentId } }
            );
            const cancelResult = await cancelResponse.json();
            const cancelErrors = cancelResult.data?.fulfillmentCancel?.userErrors;
            if (cancelErrors && cancelErrors.length > 0) {
                // Only block on errors that aren't "already cancelled"
                const realErrors = cancelErrors.filter(
                    (e) => !e.message.toLowerCase().includes("already cancelled") &&
                        !e.message.toLowerCase().includes("cannot cancel")
                );
                if (realErrors.length > 0) {
                    errors = realErrors;
                }
            }
            // Delete parcel and increment stock from DB regardless
            if (errors.length === 0) {
                await prisma.$transaction(async (tx) => {
                    for (const addonLink of parcel.addons) {
                        await tx.addonProduct.update({
                            where: { id: addonLink.addonId },
                            data: { stock: { increment: addonLink.quantity } },
                        });
                    }
                    await tx.parcel.delete({ where: { id: parcelId } });
                });
                return json({ errors, deleted: true });
            }
        }
    }

    return json({ errors, deleted: false });
};

export default function OrderDetails() {
    const { order, packages, carriers, addons, parcels, shop, printSettings } = useLoaderData();
    const actionData = useActionData();
    const submit = useSubmit();
    const navigation = useNavigation();

    const [note, setNote] = useState(order?.note || "");
    const [newTag, setNewTag] = useState("");

    // Delete parcel confirmation modal
    const [deleteModalOpen, setDeleteModalOpen] = useState(false);
    const [parcelToDelete, setParcelToDelete] = useState(null);

    const openDeleteModal = useCallback((parcel) => {
        setParcelToDelete(parcel);
        setDeleteModalOpen(true);
    }, []);

    const closeDeleteModal = useCallback(() => {
        setDeleteModalOpen(false);
        setParcelToDelete(null);
    }, []);

    const handleDeleteParcel = useCallback(() => {
        if (!parcelToDelete) return;
        submit(
            { actionType: "deleteParcel", parcelId: parcelToDelete.id.toString() },
            { method: "post" }
        );
        closeDeleteModal();
    }, [parcelToDelete, submit, closeDeleteModal]);

    // Wizard State
    const [isWizardOpen, setIsWizardOpen] = useState(false);

    const isSubmitting = navigation.state === "submitting";

    const handleUpdateNote = useCallback(() => {
        submit({ actionType: "updateNote", note }, { method: "post" });
    }, [note, submit]);

    const handleAddTag = useCallback(() => {
        if (!newTag.trim()) return;
        submit(
            { actionType: "addTag", tags: newTag.trim() },
            { method: "post" }
        );
        setNewTag("");
    }, [newTag, submit]);

    const handleRemoveTag = useCallback(
        (tag) => {
            submit({ actionType: "removeTag", tags: tag }, { method: "post" });
        },
        [submit]
    );

    const handleMarkPaid = useCallback(() => {
        submit({ actionType: "markPaid" }, { method: "post" });
    }, [submit]);

    const handlePrintLabel = useCallback((parcel) => {
        printLabel({ order, shop, parcel, printSettings });
    }, [order, shop, printSettings]);

    const handlePrintInvoice = useCallback(() => {
        printInvoice({ order, shop, printSettings, parcels });
    }, [order, shop, printSettings, parcels]);

    if (!order) {
        return (
            <Page>
                <Text>Order not found</Text>
            </Page>
        );
    }

    const customerName = order.customer
        ? `${order.customer.firstName || ""} ${order.customer.lastName || ""}`.trim()
        : "No customer details";

    const price = new Intl.NumberFormat("en-US", {
        style: "currency",
        currency: order.totalPriceSet.shopMoney.currencyCode,
    }).format(order.totalPriceSet.shopMoney.amount);


    return (
        <Page
            backAction={{ content: "Orders", url: "/app" }}
            title={`Order ${order.name}`}
            subtitle={new Date(order.createdAt).toLocaleString()}
            secondaryActions={[
                {
                    content: "Print Invoice",
                    onAction: handlePrintInvoice,
                },
            ]}
            compactTitle
            titleMetadata={
                <InlineStack gap="200" align="center">
                    <Badge
                        tone={
                            order.displayFinancialStatus === "PAID"
                                ? "success"
                                : order.displayFinancialStatus === "PENDING"
                                    ? "warning"
                                    : "new"
                        }
                    >
                        {order.displayFinancialStatus || "UNKNOWN"}
                    </Badge>
                    <Badge
                        tone={
                            order.displayFulfillmentStatus === "FULFILLED"
                                ? "success"
                                : order.displayFulfillmentStatus === "UNFULFILLED"
                                    ? "attention"
                                    : "new"
                        }
                    >
                        {order.displayFulfillmentStatus || "UNFULFILLED"}
                    </Badge>
                </InlineStack>
            }
        >
            <Layout>
                <Layout.Section>
                    <BlockStack gap="500">
                        {/* Action Errors */}
                        {actionData?.errors?.length > 0 && (
                            <Card background="bg-surface-critical-active">
                                <Text tone="critical" as="p">
                                    There was an error processing your request:
                                </Text>
                                <ul>
                                    {actionData.errors.map((error, index) => (
                                        <li key={index}>
                                            <Text tone="critical" as="span">
                                                {error.message}
                                            </Text>
                                        </li>
                                    ))}
                                </ul>
                            </Card>
                        )}

                        {/* Line Items */}
                        <Card>
                            <BlockStack gap="400">
                                <Text variant="headingMd" as="h2">
                                    Items
                                </Text>
                                <List>
                                    {order.lineItems.edges.map(({ node }) => (
                                        <List.Item key={node.id}>
                                            <InlineStack align="space-between">
                                                <Text as="span">{node.quantity} x {node.title}</Text>
                                                <Text as="span">
                                                    {new Intl.NumberFormat("en-US", {
                                                        style: "currency",
                                                        currency: node.originalTotalSet.shopMoney.currencyCode,
                                                    }).format(node.originalTotalSet.shopMoney.amount)}
                                                </Text>
                                            </InlineStack>
                                        </List.Item>
                                    ))}
                                </List>
                                <Box paddingBlockStart="400" borderBlockStart="025" borderColor="border">
                                    <InlineStack align="space-between">
                                        <Text variant="headingMd" as="h3">Total</Text>
                                        <Text variant="headingMd" as="h3">{price}</Text>
                                    </InlineStack>
                                </Box>
                            </BlockStack>
                        </Card>

                        {/* Parcels (from DB) */}
                        {parcels && parcels.length > 0 && (
                            <Card>
                                <BlockStack gap="400">
                                    <Text variant="headingMd" as="h2">
                                        Parcels
                                    </Text>
                                    {parcels.map((parcel, idx) => (
                                        <Box key={parcel.id}>
                                            {idx > 0 && <Box paddingBlockEnd="200"><Divider /></Box>}
                                            <BlockStack gap="200">
                                                <InlineStack align="space-between" blockAlign="center">
                                                    <BlockStack gap="100">
                                                        <InlineStack gap="200" align="start">
                                                            <Text as="span" fontWeight="bold">{parcel.carrierName}</Text>
                                                            <Badge tone={parcel.dispatchStatus === "dispatched" ? "info" : parcel.dispatchStatus === "delivered" ? "success" : parcel.dispatchStatus === "cancelled" ? "critical" : "warning"}>
                                                                {parcel.dispatchStatus}
                                                            </Badge>
                                                        </InlineStack>
                                                        <Text as="span" tone="subdued">AWB: {parcel.awbNumber || "—"}</Text>
                                                        <Text as="span" tone="subdued">
                                                            {parcel.length}x{parcel.width}x{parcel.height} cm · {parcel.weight} kg
                                                        </Text>
                                                        {parcel.dispatchmentId && (
                                                            <Text as="span" tone="caution">Linked to Dispatch #{parcel.dispatchmentId}</Text>
                                                        )}
                                                    </BlockStack>
                                                    <InlineStack gap="200">
                                                        <Button
                                                            size="micro"
                                                            onClick={() => handlePrintLabel(parcel)}
                                                        >
                                                            Print Label
                                                        </Button>
                                                        <Button
                                                            tone="critical"
                                                            size="micro"
                                                            onClick={() => openDeleteModal(parcel)}
                                                            disabled={isSubmitting}
                                                        >
                                                            Delete
                                                        </Button>
                                                    </InlineStack>
                                                </InlineStack>
                                            </BlockStack>
                                        </Box>
                                    ))}
                                </BlockStack>
                            </Card>
                        )}

                        {/* Fulfillments */}
                        {order.fulfillmentOrders && order.fulfillmentOrders.edges.length > 0 && (
                            <Card>
                                <BlockStack gap="400">
                                    <Text variant="headingMd" as="h2">
                                        Fulfillments
                                    </Text>
                                    {order.fulfillmentOrders.edges.map(({ node }) => {
                                        const canFulfill = node.supportedActions.some(
                                            (action) => action.action === "CREATE_FULFILLMENT"
                                        );
                                        return (
                                            <Box key={node.id} paddingBlockEnd="200" borderBlockEnd="025" borderColor="border">
                                                <BlockStack gap="200">
                                                    <InlineStack align="space-between">
                                                        <Text as="span" variant="bodyMd" fontWeight="bold">
                                                            Status: {node.status}
                                                        </Text>
                                                        {canFulfill && (
                                                            <Button
                                                                size="micro"
                                                                variant="primary"
                                                                onClick={() => setIsWizardOpen(true)}
                                                                loading={isSubmitting}
                                                            >
                                                                Create fulfillment
                                                            </Button>
                                                        )}
                                                    </InlineStack>
                                                    <List>
                                                        {node.lineItems.edges.map(({ node: fiNode }) => (
                                                            <List.Item key={fiNode.id}>
                                                                <InlineStack align="space-between" blockAlign="center" gap="400">
                                                                    <Text as="span">{fiNode.lineItem.title}</Text>
                                                                    <Text tone="subdued" as="span">{fiNode.remainingQuantity} remaining</Text>
                                                                </InlineStack>
                                                            </List.Item>
                                                        ))}
                                                    </List>
                                                </BlockStack>
                                            </Box>
                                        );
                                    })}
                                </BlockStack>
                            </Card>
                        )}
                    </BlockStack>
                </Layout.Section>

                <Layout.Section variant="oneThird">
                    <BlockStack gap="500">
                        {/* Status Actions */}
                        <Card>
                            <BlockStack gap="400">
                                <Text variant="headingMd" as="h2">
                                    Order Actions
                                </Text>
                                {order.displayFinancialStatus === "PENDING" && (
                                    <Button
                                        onClick={handleMarkPaid}
                                        loading={isSubmitting}
                                        fullWidth
                                    >
                                        Mark as Paid
                                    </Button>
                                )}
                            </BlockStack>
                        </Card>

                        {/* Customer Details */}
                        <Card>
                            <BlockStack gap="200">
                                <Text variant="headingMd" as="h2">
                                    Customer
                                </Text>
                                <Text as="p">{customerName}</Text>
                                {order.customer?.email && (
                                    <Text as="p" tone="subdued">
                                        {order.customer.email}
                                    </Text>
                                )}
                            </BlockStack>
                        </Card>

                        {/* Notes */}
                        <Card>
                            <BlockStack gap="400">
                                <Text variant="headingMd" as="h2">
                                    Notes
                                </Text>
                                <TextField
                                    value={note}
                                    onChange={setNote}
                                    multiline={4}
                                    autoComplete="off"
                                />
                                <Button onClick={handleUpdateNote} loading={isSubmitting}>
                                    Save Note
                                </Button>
                            </BlockStack>
                        </Card>

                        {/* Tags */}
                        <Card>
                            <BlockStack gap="400">
                                <Text variant="headingMd" as="h2">
                                    Tags
                                </Text>
                                {order.tags && order.tags.length > 0 ? (
                                    <InlineStack gap="200">
                                        {order.tags.map((tag) => (
                                            <Badge key={tag} tone="info">
                                                <InlineStack gap="100" align="center">
                                                    <Text as="span">{tag}</Text>
                                                    <Button
                                                        size="micro"
                                                        variant="plain"
                                                        onClick={() => handleRemoveTag(tag)}
                                                        loading={isSubmitting}
                                                    >
                                                        x
                                                    </Button>
                                                </InlineStack>
                                            </Badge>
                                        ))}
                                    </InlineStack>
                                ) : (
                                    <Text as="p" tone="subdued">
                                        No tags
                                    </Text>
                                )}
                                <InlineStack gap="200">
                                    <TextField
                                        value={newTag}
                                        onChange={setNewTag}
                                        autoComplete="off"
                                        placeholder="Add a tag"
                                    />
                                    <Button onClick={handleAddTag} loading={isSubmitting}>
                                        Add
                                    </Button>
                                </InlineStack>
                            </BlockStack>
                        </Card>
                    </BlockStack>
                </Layout.Section>
            </Layout>

            {/* DELETE PARCEL CONFIRMATION MODAL */}
            <Modal
                open={deleteModalOpen}
                onClose={closeDeleteModal}
                title="Delete Parcel"
                primaryAction={{
                    content: "Delete",
                    onAction: handleDeleteParcel,
                    destructive: true,
                    loading: isSubmitting,
                }}
                secondaryActions={[{ content: "Cancel", onAction: closeDeleteModal }]}
            >
                <Modal.Section>
                    <BlockStack gap="200">
                        <Text as="p">
                            Are you sure you want to delete this parcel?
                        </Text>
                        {parcelToDelete && (
                            <Text as="p" tone="subdued">
                                AWB: <strong>{parcelToDelete.awbNumber || "—"}</strong> · Carrier: {parcelToDelete.carrierName}
                            </Text>
                        )}
                        {parcelToDelete?.dispatchmentId && (
                            <Banner tone="warning">
                                This parcel is linked to Dispatch #{parcelToDelete.dispatchmentId} and <strong>cannot be deleted</strong> until it is removed from the dispatch.
                            </Banner>
                        )}
                        {!parcelToDelete?.dispatchmentId && (
                            <Banner tone="critical">
                                This will also <strong>cancel</strong> the associated Shopify fulfillment. This action cannot be undone.
                            </Banner>
                        )}
                    </BlockStack>
                </Modal.Section>
            </Modal>

            <FulfillmentWizard
                open={isWizardOpen}
                onClose={() => setIsWizardOpen(false)}
                orderId={order.id}
                orderName={order.name}
                carriers={carriers}
                packages={packages}
                addons={addons}
                onFulfilled={() => submit({}, { method: "get" })}
            />
        </Page>
    );
}
