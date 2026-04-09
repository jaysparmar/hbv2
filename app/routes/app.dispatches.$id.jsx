import { json } from "@remix-run/node";
import { useLoaderData, useNavigate } from "@remix-run/react";
import { useState, useMemo } from "react";
import { Page, Layout, Card, IndexTable, Text, Badge, BlockStack, InlineGrid, Box, Button, TextField } from "@shopify/polaris";
import db from "../db.server";
import { authenticate } from "../shopify.server";

export async function loader({ request, params }) {
    await authenticate.admin(request);
    const { id } = params;

    const dispatch = await db.dispatchment.findUnique({
        where: { id: parseInt(id) },
        include: {
            carrier: true,
            parcels: true,
        }
    });

    if (!dispatch) {
        throw new Response("Dispatch Not Found", { status: 404 });
    }

    return json({ dispatch });
}

export default function DispatchDetails() {
    const { dispatch } = useLoaderData();
    const navigate = useNavigate();
    const [isDownloading, setIsDownloading] = useState(false);
    const [searchQuery, setSearchQuery] = useState("");

    const filteredParcels = useMemo(() => {
        if (!searchQuery.trim()) return dispatch.parcels;
        const q = searchQuery.trim().toLowerCase();
        return dispatch.parcels.filter(p =>
            p.awbNumber.toLowerCase().includes(q) ||
            p.orderName.toLowerCase().includes(q)
        );
    }, [dispatch.parcels, searchQuery]);

    const handleDownload = async () => {
        setIsDownloading(true);
        try {
            const response = await fetch(`/api/dispatches/${dispatch.id}/download`);
            if (!response.ok) throw new Error("Failed to download");
            const blob = await response.blob();
            const url = window.URL.createObjectURL(blob);
            const a = document.createElement("a");
            a.href = url;
            a.download = `INDIA_POST_FINAL_REPORT_DISPATCH_${dispatch.id}.xlsx`;
            document.body.appendChild(a);
            a.click();
            a.remove();
            window.URL.revokeObjectURL(url);
        } catch (error) {
            console.error("Download error:", error);
        } finally {
            setIsDownloading(false);
        }
    };

    return (
        <Page
            backAction={{ content: 'Dispatches', onAction: () => navigate('/app/dispatches') }}
            title={`Dispatch #${dispatch.id}`}
            primaryAction={{
                content: "Export Report",
                onAction: handleDownload,
                loading: isDownloading
            }}
        >
            <Layout>
                <Layout.Section>
                    <BlockStack gap="400">
                        <Card>
                            <BlockStack gap="400">
                                <Text variant="headingMd" as="h2">Dispatch Details</Text>
                                <InlineGrid columns={2} gap="400">
                                    <BlockStack gap="200">
                                        <Text as="p" color="subdued">Carrier</Text>
                                        <Text as="p" fontWeight="bold">{dispatch.carrier.name}</Text>
                                    </BlockStack>
                                    <BlockStack gap="200">
                                        <Text as="p" color="subdued">Transit Status</Text>
                                        <Badge tone={dispatch.transitStatus === "sent" ? "success" : "info"}>
                                            {dispatch.transitStatus.toUpperCase()}
                                        </Badge>
                                    </BlockStack>
                                    <BlockStack gap="200">
                                        <Text as="p" color="subdued">Notes</Text>
                                        <Text as="p" fontWeight="bold">{dispatch.notes || "-"}</Text>
                                    </BlockStack>
                                    <BlockStack gap="200">
                                        <Text as="p" color="subdued">Created At</Text>
                                        <Text as="p" fontWeight="bold">{new Date(dispatch.createdAt).toLocaleString()}</Text>
                                    </BlockStack>
                                </InlineGrid>
                            </BlockStack>
                        </Card>

                        <Card padding="0">
                            <Box padding="400" paddingBlockEnd="200">
                                <BlockStack gap="300">
                                    <Text variant="headingMd" as="h3">Parcels ({dispatch.parcels.length})</Text>
                                    <TextField
                                        placeholder="Search by AWB number or order name..."
                                        value={searchQuery}
                                        onChange={setSearchQuery}
                                        clearButton
                                        onClearButtonClick={() => setSearchQuery("")}
                                        autoComplete="off"
                                    />
                                </BlockStack>
                            </Box>
                            <IndexTable
                                resourceName={{ singular: "parcel", plural: "parcels" }}
                                itemCount={filteredParcels.length}
                                headings={[
                                    { title: "Order" },
                                    { title: "AWB Number" },
                                    { title: "Weight" },
                                    { title: "Dimensions (cm)" },
                                    { title: "Value of Repayment" },
                                    { title: "Status" },
                                    { title: "Added At" }
                                ]}
                                selectable={false}
                            >
                                {filteredParcels.map((parcel) => (
                                    <IndexTable.Row key={parcel.id} id={parcel.id}>
                                        <IndexTable.Cell>
                                            <Button variant="plain" onClick={() => navigate(`/app/orders/${parcel.orderId.replace("gid://shopify/Order/", "")}`)}>
                                                <Text variant="bodyMd" fontWeight="bold">{parcel.orderName}</Text>
                                            </Button>
                                        </IndexTable.Cell>
                                        <IndexTable.Cell>{parcel.awbNumber}</IndexTable.Cell>
                                        <IndexTable.Cell>{parcel.weight} kg</IndexTable.Cell>
                                        <IndexTable.Cell>
                                            {parcel.length} × {parcel.width} × {parcel.height}
                                        </IndexTable.Cell>
                                        <IndexTable.Cell>{parcel.valueOfRepayment ? `₹${parcel.valueOfRepayment}` : "-"}</IndexTable.Cell>
                                        <IndexTable.Cell>
                                            <Badge tone={parcel.dispatchStatus === "dispatched" ? "success" : "info"}>
                                                {parcel.dispatchStatus.toUpperCase()}
                                            </Badge>
                                        </IndexTable.Cell>
                                        <IndexTable.Cell>{new Date(parcel.updatedAt).toLocaleString()}</IndexTable.Cell>
                                    </IndexTable.Row>
                                ))}
                            </IndexTable>
                        </Card>
                    </BlockStack>
                </Layout.Section>
            </Layout>
        </Page>
    );
}
