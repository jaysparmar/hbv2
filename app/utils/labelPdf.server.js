/**
 * Renders one combined PDF of shipping labels for the bulk "Print Shipping
 * Labels" action. Deliberately avoids a headless-browser renderer (Puppeteer/
 * Playwright) — pdfmake is pure JS with no native/system dependencies, so it
 * runs identically regardless of how this app is deployed.
 *
 * Reuses buildLabelViewModel/numberToWords from printLabel.js so the bulk PDF
 * always shows the same data as the existing single-row "Print Label" (HTML)
 * output — only the rendering target (pdfmake nodes vs. HTML/CSS) differs.
 */
import { createRequire } from "module";
import path from "path";
import { buildLabelViewModel, numberToWords } from "./printLabel";

const require = createRequire(import.meta.url);

// Resolved from the process cwd (the project root the server is started
// from) rather than import.meta.url — after the Remix/Vite SSR build
// concatenates everything into a single build/server/index.js bundle,
// import.meta.url would point at that bundle file, not this source file.
const FONTS_DIR = path.join(process.cwd(), "app", "assets", "fonts");

const MM_TO_PT = 2.8346456693;
const mm = (v) => v * MM_TO_PT;

const PAGE_WIDTH = mm(105);
const PAGE_HEIGHT = mm(148);
const PAGE_MARGIN = mm(3);
const CONTENT_WIDTH = PAGE_WIDTH - PAGE_MARGIN * 2;

function box(stack, margin = [0, 0, 0, 4]) {
    return {
        table: { widths: ["*"], body: [[{ stack }]] },
        layout: {
            hLineWidth: () => 1,
            vLineWidth: () => 1,
            hLineColor: () => "#000000",
            vLineColor: () => "#000000",
            paddingLeft: () => 4,
            paddingRight: () => 4,
            paddingTop: () => 3,
            paddingBottom: () => 3,
        },
        margin,
    };
}

function divider() {
    return {
        canvas: [{ type: "line", x1: 0, y1: 0, x2: CONTENT_WIDTH, y2: 0, lineWidth: 0.75, lineColor: "#000000" }],
        margin: [0, 4, 0, 4],
    };
}

function buildLabelBlock({ order, shop, parcel, printSettings }) {
    const {
        codAmount, isCOD, addr, cName, customerPhone, orderDate, products, fmt,
        headerText, bnplLine1, bnplLine2, billerId, fromName, storeAddr,
    } = buildLabelViewModel({ order, shop, parcel, printSettings });

    const content = [];

    content.push({
        table: { widths: ["*"], body: [[{ text: headerText, color: "white", bold: true, fontSize: 10, alignment: "center", fillColor: "#000000" }]] },
        layout: "noBorders",
        margin: [0, 0, 0, 4],
    });

    content.push(box([
        { text: `${bnplLine1}${isCOD ? " (SP-COD)" : ""}`, bold: true, fontSize: 9, alignment: "center" },
        ...(bnplLine2 ? [{ text: bnplLine2, fontSize: 7.5, alignment: "center", margin: [0, 1, 0, 0] }] : []),
        ...(billerId ? [{ text: `Biller ID: ${billerId}`, fontSize: 7.5, alignment: "center", margin: [0, 1, 0, 0] }] : []),
    ]));

    if (isCOD) {
        content.push(box([
            { text: "COD COLLECT AMOUNT", bold: true, fontSize: 8, alignment: "center" },
            { text: fmt(codAmount), bold: true, fontSize: 13, alignment: "center", margin: [0, 1, 0, 1] },
            { text: `Words: ${numberToWords(codAmount)}`, fontSize: 7, alignment: "center" },
        ]));
    }

    const addressStack = (label, name, a1, a2, cityProvinceZip, country, phone) => ([
        { text: label, bold: true, fontSize: 7.5, decoration: "underline", margin: [0, 0, 0, 1] },
        { text: name, bold: true, fontSize: 9.5 },
        ...(a1 ? [{ text: a1, fontSize: 8 }] : []),
        ...(a2 ? [{ text: a2, fontSize: 8 }] : []),
        { text: cityProvinceZip, fontSize: 8 },
        ...(country ? [{ text: country, fontSize: 8 }] : []),
        ...(phone ? [{ text: `Ph: ${phone}`, fontSize: 8 }] : []),
    ]);

    content.push({
        columns: [
            {
                width: "*",
                stack: addressStack(
                    "To,", cName, addr.address1, addr.address2,
                    [addr.city, addr.province, addr.zip].filter(Boolean).join(", "),
                    addr.country, customerPhone
                ),
            },
            {
                width: "*",
                stack: addressStack(
                    "From,", fromName, storeAddr.address1, storeAddr.address2,
                    [storeAddr.city, storeAddr.province, storeAddr.zip].filter(Boolean).join(", "),
                    null, storeAddr.phone ? `Mo: ${storeAddr.phone}`.replace(/^Mo: /, "") : null
                ),
            },
        ],
        columnGap: mm(2),
    });

    content.push(divider());

    content.push(box([
        { text: parcel.awbNumber || "—", bold: true, fontSize: 13, alignment: "center", characterSpacing: 1 },
    ]));

    content.push({
        columns: [
            { text: `Pay Mode: ${isCOD ? "COD" : "PREPAID"}`, fontSize: 7.5 },
            { text: `Order: ${order.name}`, fontSize: 7.5 },
            { text: `Date: ${orderDate}`, fontSize: 7.5 },
            { text: `Carrier: ${parcel.carrierName || ""}`, fontSize: 7.5, alignment: "right" },
        ],
        margin: [0, 0, 0, 4],
    });

    content.push(divider());

    content.push({
        table: {
            widths: ["*", "auto", "auto"],
            body: [
                [
                    { text: "Product", bold: true, fontSize: 7.5, fillColor: "#eeeeee" },
                    { text: "Qty", bold: true, fontSize: 7.5, fillColor: "#eeeeee" },
                    { text: "Price", bold: true, fontSize: 7.5, fillColor: "#eeeeee" },
                ],
                ...products.map((p) => [
                    { text: p.title, fontSize: 7.5 },
                    { text: String(p.quantity), fontSize: 7.5 },
                    { text: fmt(p.originalTotalSet.shopMoney.amount), fontSize: 7.5 },
                ]),
            ],
        },
        layout: {
            hLineWidth: () => 0.5,
            vLineWidth: () => 0.5,
            hLineColor: () => "#000000",
            vLineColor: () => "#000000",
            paddingLeft: () => 2,
            paddingRight: () => 2,
            paddingTop: () => 1,
            paddingBottom: () => 1,
        },
        margin: [0, 2, 0, 2],
    });

    content.push({
        columns: [
            { text: `Total: ${fmt(order.totalPriceSet.shopMoney.amount)}`, fontSize: 7.5 },
            { text: `${parcel.length}x${parcel.width}x${parcel.height}cm · ${parcel.weight}kg`, fontSize: 7.5, alignment: "right" },
        ],
        margin: [0, 1, 0, 0],
    });

    return content;
}

/**
 * @param {Array<{ order: object, shop: object, parcel: object, printSettings: object }>} labelsData
 * @returns {Promise<Buffer>}
 */
export async function generateLabelsPdfBuffer(labelsData) {
    const require_ = require;
    const pdfMakeModule = require_("pdfmake/js/index.js");
    const pdfMake = pdfMakeModule.default?.default || pdfMakeModule.default || pdfMakeModule;

    pdfMake.setFonts({
        Roboto: {
            normal: path.join(FONTS_DIR, "Roboto-Regular.ttf"),
            bold: path.join(FONTS_DIR, "Roboto-Medium.ttf"),
            italics: path.join(FONTS_DIR, "Roboto-Italic.ttf"),
            bolditalics: path.join(FONTS_DIR, "Roboto-MediumItalic.ttf"),
        },
    });
    pdfMake.setUrlAccessPolicy(() => false);
    pdfMake.setLocalAccessPolicy((filePath) => filePath.startsWith(FONTS_DIR));

    const content = [];
    labelsData.forEach((data, index) => {
        const block = buildLabelBlock(data);
        if (index > 0) block[0] = { ...block[0], pageBreak: "before" };
        content.push(...block);
    });

    const docDefinition = {
        pageSize: { width: PAGE_WIDTH, height: PAGE_HEIGHT },
        pageMargins: [PAGE_MARGIN, PAGE_MARGIN, PAGE_MARGIN, PAGE_MARGIN],
        content,
        defaultStyle: { font: "Roboto", fontSize: 8 },
    };

    const pdfDoc = pdfMake.createPdf(docDefinition);
    return pdfDoc.getBuffer();
}
