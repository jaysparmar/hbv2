import { json } from "@remix-run/node";
import { useLoaderData } from "@remix-run/react";
import { Page, Layout, Card, IndexTable, Text, Badge, Link, InlineStack } from "@shopify/polaris";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";

export const loader = async ({ request }) => {
    await authenticate.admin(request);
    const parcels = await prisma.parcel.findMany({
        orderBy: { createdAt: "desc" },
    });
    return json({ parcels });
};

export default function ParcelsMaster() {
    const { parcels } = useLoaderData();

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
                        <IndexTable
                            resourceName={{ singular: "parcel", plural: "parcels" }}
                            itemCount={parcels.length}
                            headings={[
                                { title: "Order ID" },
                                { title: "Carrier" },
                                { title: "AWB Number" },
                                { title: "Dimensions (L x W x H) & W" },
                                { title: "Dispatch Status" },
                                { title: "Created At" },
                            ]}
                            selectable={false}
                        >
                            {rowMarkup}
                        </IndexTable>
                    </Card>
                </Layout.Section>
            </Layout>
        </Page>
    );
}
