import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import * as xlsx from "xlsx";

const dateRegex = /^\d{4}-\d{2}-\d{2}$/;

function formatDDMMYYYY(date) {
    if (!date) return "";
    const d = new Date(date);
    if (isNaN(d.getTime())) return "";
    const dd = String(d.getDate()).padStart(2, "0");
    const mm = String(d.getMonth() + 1).padStart(2, "0");
    const yyyy = d.getFullYear();
    return `${dd}-${mm}-${yyyy}`;
}

function itemsSummary(json) {
    if (!json) return "";
    try {
        const items = JSON.parse(json);
        if (!Array.isArray(items)) return "";
        return items.map((i) => `${i.title} x${i.quantity}`).join(", ");
    } catch {
        return "";
    }
}

function syncStatusLabel(row) {
    if (row.shopifyReturnId) return "Synced";
    if (row.shopifyReturnError) return "Failed";
    return "Local Only";
}

export async function loader({ request }) {
    await authenticate.admin(request);

    const url = new URL(request.url);
    const startDate = url.searchParams.get("startDate");
    const endDate = url.searchParams.get("endDate");

    if (!startDate || !endDate || !dateRegex.test(startDate) || !dateRegex.test(endDate)) {
        return new Response("Invalid date format or parameters. Please use YYYY-MM-DD.", { status: 400 });
    }

    const parcels = await prisma.parcel.findMany({
        where: {
            dispatchStatus: "returned",
            returnedAt: {
                gte: new Date(`${startDate}T00:00:00Z`),
                lte: new Date(`${endDate}T23:59:59Z`)
            }
        },
        orderBy: { returnedAt: "desc" }
    });

    const aoa = [
        [
            "SR. NO.",
            "AWB",
            "Order No.",
            "Carrier",
            "Return Date",
            "COD Value",
            "Items",
            "Shopify Sync Status"
        ]
    ];

    parcels.forEach((row, idx) => {
        aoa.push([
            idx + 1,
            row.awbNumber || "",
            row.orderName || "",
            row.carrierName || "",
            formatDDMMYYYY(row.returnedAt),
            parseFloat(row.valueOfRepayment) || 0,
            itemsSummary(row.returnedItemsSnapshot),
            syncStatusLabel(row)
        ]);
    });

    const totalCodValue = parcels.reduce((sum, r) => sum + (parseFloat(r.valueOfRepayment) || 0), 0);
    aoa.push(["TOTAL", "", "", "", "", totalCodValue, "", ""]);

    const worksheet = xlsx.utils.aoa_to_sheet(aoa);
    const workbook = xlsx.utils.book_new();
    xlsx.utils.book_append_sheet(workbook, worksheet, "Sheet1");

    const buffer = xlsx.write(workbook, { type: "buffer", bookType: "xlsx" });

    return new Response(buffer, {
        status: 200,
        headers: {
            "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            "Content-Disposition": `attachment; filename="RETURNS_REPORT_${startDate}_TO_${endDate}.xlsx"`
        }
    });
}
