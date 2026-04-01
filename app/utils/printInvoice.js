/**
 * Shared print invoice utility.
 * Generates a professional tax invoice HTML and opens a print window.
 * Includes GST breakdown: SGST+CGST for Gujarat, IGST for other states.
 */

import { numberToWords } from "./printLabel";

const GUJARAT_VARIANTS = [
    "gujarat", "gj", "guj", "gu",
];

function isGujarat(province) {
    if (!province) return false;
    return GUJARAT_VARIANTS.includes(province.toLowerCase().trim());
}

/**
 * Generate the full HTML document for a tax invoice.
 *
 * @param {Object} params
 * @param {Object} params.order         - Shopify order object
 * @param {Object} params.shop          - Shopify shop object
 * @param {Object} [params.printSettings] - Optional print settings from DB
 * @returns {string} Full HTML document string
 */
export function generateInvoiceHtml({ order, shop, printSettings = {}, parcels = [] }) {
    const s = printSettings;
    const currency = order.totalPriceSet.shopMoney.currencyCode;
    const totalAmount = parseFloat(order.totalPriceSet.shopMoney.amount);
    const outstandingAmount = parseFloat(order.totalOutstandingSet?.shopMoney?.amount || 0);
    const paidAmount = totalAmount - outstandingAmount;
    const addr = order.shippingAddress || {};
    const cName = order.customer
        ? `${order.customer.firstName || ""} ${order.customer.lastName || ""}`.trim()
        : "Walk-in Customer";
    const customerEmail = order.customer?.defaultEmailAddress?.emailAddress || "";
    const customerPhone = addr.phone || order.customer?.defaultPhoneNumber?.phoneNumber || "";

    // Use settings overrides or fall back to shop billing address
    const storeAddr = {
        address1: s.invoice_from_address1 || shop?.billingAddress?.address1 || "",
        address2: s.invoice_from_address2 || shop?.billingAddress?.address2 || "",
        city: s.invoice_from_city || shop?.billingAddress?.city || "",
        province: s.invoice_from_province || shop?.billingAddress?.province || "",
        zip: s.invoice_from_zip || shop?.billingAddress?.zip || "",
        phone: s.invoice_from_phone || shop?.billingAddress?.phone || "",
    };
    const storeEmail = s.invoice_from_email || "";
    const companyName = s.invoice_company_name || shop?.name || "Store";
    const invoiceTitle = s.invoice_title || "Tax Invoice";
    const gstin = s.invoice_gstin || "";
    const footerText = s.invoice_footer || "Thank you for your business!";
    const termsText = s.invoice_terms || "";

    const orderDate = new Date(order.createdAt).toLocaleDateString("en-IN", {
        day: "2-digit", month: "short", year: "numeric",
    });
    const products = order.lineItems.edges.map(({ node }) => node);
    if (parcels && parcels.length > 0) {
        parcels.forEach(parcel => {
            if (parcel.addons) {
                parcel.addons.forEach(pa => {
                    products.push({
                        title: `${pa.addon.name} (Free Add-on from Parcel ${parcel.awbNumber || parcel.id})`,
                        quantity: pa.quantity,
                        originalTotalSet: { shopMoney: { amount: "0.00", currencyCode: currency } }
                    });
                });
            }
        });
    }
    const fmt = (amt) => new Intl.NumberFormat("en-IN", { style: "currency", currency }).format(amt);

    // ─── GST Calculation (tax-inclusive) ───
    const customerInGujarat = isGujarat(addr.province);
    const gstRate = customerInGujarat ? 0.05 : 0.18; // 5% intra-state, 18% inter-state
    const taxableAmount = totalAmount / (1 + gstRate);
    const totalGst = totalAmount - taxableAmount;

    let gstLabel1, gstLabel2, gstAmt1, gstAmt2;
    if (customerInGujarat) {
        gstLabel1 = "SGST @ 2.5%";
        gstLabel2 = "CGST @ 2.5%";
        gstAmt1 = taxableAmount * 0.025;
        gstAmt2 = taxableAmount * 0.025;
    } else {
        gstLabel1 = "IGST @ 18%";
        gstLabel2 = null;
        gstAmt1 = totalGst;
        gstAmt2 = 0;
    }

    // Product rows with taxable values
    const productRows = products.map((p, i) => {
        const lineTotal = parseFloat(p.originalTotalSet.shopMoney.amount);
        const lineTaxable = lineTotal / (1 + gstRate);
        const unitTaxable = lineTaxable / (p.quantity || 1);
        return `<tr>
            <td style="text-align:center">${i + 1}</td>
            <td>${p.title}</td>
            <td style="text-align:center">${p.quantity}</td>
            <td style="text-align:right">${fmt(unitTaxable)}</td>
            <td style="text-align:right">${fmt(lineTaxable)}</td>
        </tr>`;
    }).join("");

    return `<!DOCTYPE html>
<html><head>
<meta charset="utf-8">
<title>Invoice - ${order.name}</title>
<style>
@page { size: A4; margin: 4mm; }
* { box-sizing: border-box; margin: 0; padding: 0; }
body { font-family: 'Segoe UI', Arial, sans-serif; font-size: 8.5pt; color: #000; line-height: 1.25; }
.invoice { max-width: 210mm; margin: 0 auto; padding: 4mm; }
.header { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 3mm; padding-bottom: 2mm; border-bottom: 1.5px solid #000; }
.company-name { font-size: 13pt; font-weight: bold; color: #000; }
.company-gstin { font-size: 8pt; color: #000; margin-top: 1px; }
.company-details { font-size: 7.5pt; color: #000; margin-top: 1mm; }
.invoice-title { text-align: right; }
.invoice-title h2 { font-size: 12pt; color: #000; text-transform: uppercase; letter-spacing: 1px; }
.invoice-meta { font-size: 8pt; color: #000; margin-top: 1mm; }
.invoice-meta strong { color: #000; }
.addresses { display: flex; gap: 4mm; margin: 3mm 0; }
.address-block { flex: 1; padding: 2mm; border-radius: 1.5mm; border: 0.5pt solid #000; }
.address-label { font-size: 7pt; text-transform: uppercase; letter-spacing: 0.5px; color: #000; font-weight: bold; margin-bottom: 1mm; border-bottom: 0.5pt solid #000; padding-bottom: 0.5mm; display: inline-block; }
.address-name { font-weight: bold; font-size: 9pt; color: #000; }
table.items { width: 100%; border-collapse: collapse; margin: 3mm 0; border: 0.5px solid #000; }
table.items th { background: #fff; color: #000; padding: 1mm 1.5mm; font-size: 7.5pt; text-transform: uppercase; border: 0.5px solid #000; }
table.items td { padding: 1mm 1.5mm; border: 0.5px solid #000; font-size: 8pt; }
table.items tr:nth-child(even) { background: #fff; }
.totals { display: flex; justify-content: flex-end; margin-top: 2mm; }
.totals-table { width: 50%; border-collapse: collapse; }
.totals-table td { padding: 1mm 1.5mm; font-size: 8pt; }
.totals-table .total-row { font-weight: bold; font-size: 9pt; color: #000; border-top: 1.5px solid #000; }
.totals-table .tax-row td { font-size: 8pt; color: #000; }
.totals-table .label { text-align: right; padding-right: 2mm; }
.totals-table .value { text-align: right; }
.amount-words { margin-top: 3mm; padding: 1.5mm; border: 0.5pt solid #000; border-radius: 1.5mm; font-size: 8pt; }
.amount-words strong { color: #000; }
.payment-status { margin-top: 3mm; display: flex; gap: 3mm; }
.status-badge { display: inline-block; padding: 1mm 2mm; border-radius: 1.5mm; font-size: 7.5pt; font-weight: bold; text-transform: uppercase; border: 0.5px solid #000; background: #fff; color: #000; }
.status-paid { background: #fff; color: #000; border: 1px solid #000; }
.status-cod { background: #fff; color: #000; border: 1px solid #000; }
.status-partial { background: #fff; color: #000; border: 1px solid #000; }
.gst-info { margin-top: 2mm; padding: 1.5mm; border: 0.5pt solid #000; border-radius: 1.5mm; font-size: 7.5pt; color: #000; background: #fff; }
.footer { margin-top: 4mm; padding-top: 2mm; border-top: 1px solid #000; display: flex; justify-content: space-between; font-size: 7.5pt; color: #000; }
.terms { margin-top: 3mm; padding: 1.5mm; border: 0.5pt solid #000; border-radius: 1.5mm; font-size: 7.5pt; color: #000; }
.terms strong { color: #000; display: block; margin-bottom: 0.5mm; font-size: 8pt; }
.signature { margin-top: 6mm; text-align: right; }
.signature-line { border-top: 1px solid #000; width: 40mm; display: inline-block; margin-top: 5mm; }
.signature-img { max-height: 15mm; max-width: 40mm; object-fit: contain; display: inline-block; }
.signature-label { font-size: 7.5pt; color: #000; margin-top: 1px; }
@media print { body { -webkit-print-color-adjust: exact; print-color-adjust: exact; margin: 0; padding: 0; width: 100%; height: 100%; overflow: hidden; } .invoice { transform: scale(0.97); transform-origin: top center; page-break-after: avoid; } }
</style></head>
<body>
<div class="invoice">
    <div class="header">
        <div>
            <div class="company-name">${companyName}</div>
            ${gstin ? `<div class="company-gstin">GSTIN: ${gstin}</div>` : ""}
            <div class="company-details">
                ${storeAddr.address1 ? `${storeAddr.address1}<br>` : ""}
                ${storeAddr.address2 ? `${storeAddr.address2}<br>` : ""}
                ${[storeAddr.city, storeAddr.province, storeAddr.zip].filter(Boolean).join(", ")}
                ${storeAddr.phone ? `<br>Phone: ${storeAddr.phone}` : ""}
                ${storeEmail ? `<br>${storeEmail}` : ""}
            </div>
        </div>
        <div class="invoice-title">
            <h2>${invoiceTitle}</h2>
            <div class="invoice-meta">
                <strong>Invoice #:</strong> ${order.name}<br>
                <strong>Date:</strong> ${orderDate}<br>
                <strong>Payment:</strong> ${order.displayFinancialStatus || "N/A"}
            </div>
        </div>
    </div>

    <div class="addresses">
        <div class="address-block">
            <div class="address-label">Bill To</div>
            <div class="address-name">${cName}</div>
            ${addr.address1 ? `<div>${addr.address1}</div>` : ""}
            ${addr.address2 ? `<div>${addr.address2}</div>` : ""}
            <div>${[addr.city, addr.province, addr.zip].filter(Boolean).join(", ")}</div>
            ${addr.country ? `<div>${addr.country}</div>` : ""}
            ${customerPhone ? `<div>Phone: ${customerPhone}</div>` : ""}
            ${customerEmail ? `<div>${customerEmail}</div>` : ""}
        </div>
        <div class="address-block">
            <div class="address-label">Ship To</div>
            <div class="address-name">${cName}</div>
            ${addr.address1 ? `<div>${addr.address1}</div>` : ""}
            ${addr.address2 ? `<div>${addr.address2}</div>` : ""}
            <div>${[addr.city, addr.province, addr.zip].filter(Boolean).join(", ")}</div>
            ${addr.country ? `<div>${addr.country}</div>` : ""}
        </div>
    </div>

    <table class="items">
        <thead>
            <tr>
                <th style="width:8%;text-align:center">#</th>
                <th style="width:42%">Product</th>
                <th style="width:12%;text-align:center">Qty</th>
                <th style="width:19%;text-align:right">Unit Price</th>
                <th style="width:19%;text-align:right">Taxable Amt</th>
            </tr>
        </thead>
        <tbody>
            ${productRows}
        </tbody>
    </table>

    <div class="totals">
        <table class="totals-table">
            <tr>
                <td class="label">Taxable Amount:</td>
                <td class="value">${fmt(taxableAmount)}</td>
            </tr>
            <tr class="tax-row">
                <td class="label">${gstLabel1}:</td>
                <td class="value">${fmt(gstAmt1)}</td>
            </tr>
            ${gstLabel2 ? `
            <tr class="tax-row">
                <td class="label">${gstLabel2}:</td>
                <td class="value">${fmt(gstAmt2)}</td>
            </tr>` : ""}
            <tr class="total-row">
                <td class="label" style="padding-top:2mm">Grand Total (Incl. GST):</td>
                <td class="value" style="padding-top:2mm">${fmt(totalAmount)}</td>
            </tr>
            ${outstandingAmount > 0 && paidAmount > 0 ? `
            <tr>
                <td class="label" style="padding-top:2mm">Amount Paid:</td>
                <td class="value" style="padding-top:2mm">${fmt(paidAmount)}</td>
            </tr>
            <tr class="total-row">
                <td class="label">Balance Due:</td>
                <td class="value">${fmt(outstandingAmount)}</td>
            </tr>` : ""}
        </table>
    </div>

    <div class="gst-info">
        ${customerInGujarat
            ? `Intra-State Supply (Gujarat) · SGST: ${fmt(gstAmt1)} + CGST: ${fmt(gstAmt2)} = Total GST: ${fmt(totalGst)}`
            : `Inter-State Supply · IGST: ${fmt(gstAmt1)} = Total GST: ${fmt(totalGst)}`
        }
    </div>

    <div class="amount-words">
        <strong>Amount in words:</strong> ${numberToWords(totalAmount)}
    </div>

    <div class="payment-status">
        ${outstandingAmount > 0 && paidAmount > 0
            ? `<span class="status-badge status-partial">Partially Paid — ${fmt(paidAmount)} | Due: ${fmt(outstandingAmount)}</span>`
            : outstandingAmount > 0
            ? `<span class="status-badge status-cod">COD — Amount Due: ${fmt(outstandingAmount)}</span>`
            : `<span class="status-badge status-paid">Paid — ${fmt(paidAmount)}</span>`
        }
    </div>

    ${termsText ? `
    <div class="terms">
        <strong>Terms & Conditions</strong>
        ${termsText.split("\n").map(l => `<div>${l}</div>`).join("")}
    </div>` : ""}

    <div class="signature">
        ${s.invoice_signature 
            ? `<div><img src="${s.invoice_signature}" class="signature-img" /></div>`
            : `<div class="signature-line"></div>`
        }
        <div class="signature-label">Authorized Signature</div>
    </div>

    <div class="footer">
        <span>Invoice ${order.name} · ${orderDate}</span>
        <span>${footerText}</span>
    </div>
</div>
<script>window.onload=function(){window.print();};</script>
</body></html>`;
}

/**
 * Open a print window with the invoice.
 *
 * @param {Object} params - { order, shop, printSettings }
 */
export function printInvoice(params) {
    const html = generateInvoiceHtml(params);
    const w = window.open("", "_blank", "width=800,height=1000");
    if (w) { w.document.write(html); w.document.close(); }
}
