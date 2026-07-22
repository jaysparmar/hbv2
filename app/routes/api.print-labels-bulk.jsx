import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { buildParcelWhere } from "../utils/parcelFilters.server";
import { getPrintSettings } from "../utils/printSettings.server";
import { resolveOrderForPrint } from "../utils/resolveOrderForPrint.server";
import { generateLabelsPdfBuffer } from "../utils/labelPdf.server";

const MAX_PARCELS_PER_JOB = 300;

export async function loader({ request }) {
    const { admin } = await authenticate.admin(request);
    const url = new URL(request.url);

    let parcelIds;
    if (url.searchParams.get("allPages") === "1") {
        const q = url.searchParams.get("q") || "";
        const dispatchStatusParam = url.searchParams.get("dispatchStatus") || "";
        const where = buildParcelWhere({ q, dispatchStatusParam });
        const matching = await prisma.parcel.findMany({ where, select: { id: true }, orderBy: { createdAt: "desc" } });
        parcelIds = matching.map((p) => p.id);
    } else {
        const idsParam = url.searchParams.get("ids") || "";
        parcelIds = idsParam
            .split(",")
            .map((id) => parseInt(id, 10))
            .filter((id) => !isNaN(id));
    }

    if (parcelIds.length === 0) {
        return new Response("No parcels selected", { status: 400 });
    }
    if (parcelIds.length > MAX_PARCELS_PER_JOB) {
        return new Response(`Too many parcels selected (${parcelIds.length}). Please narrow your filter to ${MAX_PARCELS_PER_JOB} or fewer parcels per print job.`, { status: 400 });
    }

    const parcels = await prisma.parcel.findMany({
        where: { id: { in: parcelIds } },
        include: { addons: { include: { addon: true } } },
    });
    const parcelsById = new Map(parcels.map((p) => [p.id, p]));
    const orderedParcels = parcelIds.map((id) => parcelsById.get(id)).filter(Boolean);

    if (orderedParcels.length === 0) {
        return new Response("No matching parcels found", { status: 404 });
    }

    const [shopResponse, printSettings] = await Promise.all([
        admin.graphql(`#graphql
            query {
                shop {
                    name
                    billingAddress {
                        address1 address2 city province zip country phone
                    }
                }
            }
        `),
        getPrintSettings(),
    ]);
    const shop = (await shopResponse.json())?.data?.shop;

    const labelsData = [];
    for (const parcel of orderedParcels) {
        let order = null;
        try {
            order = await resolveOrderForPrint({ orderId: parcel.orderId, admin });
        } catch (err) {
            console.error(`Failed to resolve order for parcel ${parcel.id} (${parcel.orderId}):`, err);
        }
        if (!order) continue;
        labelsData.push({ order, shop, parcel, printSettings });
    }

    if (labelsData.length === 0) {
        return new Response("Could not resolve order data for any selected parcel", { status: 404 });
    }

    const pdfBuffer = await generateLabelsPdfBuffer(labelsData);

    return new Response(pdfBuffer, {
        status: 200,
        headers: {
            "Content-Type": "application/pdf",
            "Content-Disposition": 'inline; filename="shipping-labels.pdf"',
        },
    });
}
