/**
 * Shared print invoice utility.
 * Generates a professional tax invoice HTML and opens a print window.
 */

import { numberToWords } from "./printLabel";

/**
 * Generate the full HTML document for a tax invoice.
 *
 * @param {Object} params
 * @param {Object} params.order  - Shopify order object
 * @param {Object} params.shop   - Shopify shop object
 * @returns {string} Full HTML document string
 */
export function generateInvoiceHtml({ order, shop }) {
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
    const storeAddr = shop?.billingAddress || {};
    const orderDate = new Date(order.createdAt).toLocaleDateString("en-IN", {
        day: "2-digit", month: "short", year: "numeric",
    });
    const products = order.lineItems.edges.map(({ node }) => node);
    const fmt = (amt) => new Intl.NumberFormat("en-IN", { style: "currency", currency }).format(amt);

    const productRows = products.map((p, i) => {
        const unitPrice = parseFloat(p.originalTotalSet.shopMoney.amount) / (p.quantity || 1);
        return `<tr>
            <td style="text-align:center">${i + 1}</td>
            <td>${p.title}</td>
            <td style="text-align:center">${p.quantity}</td>
            <td style="text-align:right">${fmt(unitPrice)}</td>
            <td style="text-align:right">${fmt(p.originalTotalSet.shopMoney.amount)}</td>
        </tr>`;
    }).join("");

    return `<!DOCTYPE html>
<html><head>
<meta charset="utf-8">
<title>Invoice - ${order.name}</title>
<style>
@page { size: A4; margin: 10mm; }
* { box-sizing: border-box; margin: 0; padding: 0; }
body { font-family: 'Segoe UI', Arial, sans-serif; font-size: 10pt; color: #333; line-height: 1.4; }
.invoice { max-width: 210mm; margin: 0 auto; padding: 8mm; }
.header { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 6mm; padding-bottom: 4mm; border-bottom: 2px solid #2c3e50; }
.company-name { font-size: 18pt; font-weight: bold; color: #2c3e50; }
.company-details { font-size: 8pt; color: #666; margin-top: 2mm; }
.invoice-title { text-align: right; }
.invoice-title h2 { font-size: 16pt; color: #2c3e50; text-transform: uppercase; letter-spacing: 2px; }
.invoice-meta { font-size: 9pt; color: #666; margin-top: 2mm; }
.invoice-meta strong { color: #333; }
.addresses { display: flex; gap: 6mm; margin: 5mm 0; }
.address-block { flex: 1; background: #f8f9fa; padding: 4mm; border-radius: 2mm; border: 0.5pt solid #e0e0e0; }
.address-label { font-size: 7.5pt; text-transform: uppercase; letter-spacing: 1px; color: #999; font-weight: bold; margin-bottom: 2mm; }
.address-name { font-weight: bold; font-size: 11pt; color: #2c3e50; }
table.items { width: 100%; border-collapse: collapse; margin: 4mm 0; }
table.items th { background: #2c3e50; color: #fff; padding: 2.5mm 3mm; font-size: 8.5pt; text-transform: uppercase; letter-spacing: 0.5px; }
table.items td { padding: 2.5mm 3mm; border-bottom: 0.5pt solid #e0e0e0; font-size: 9.5pt; }
table.items tr:nth-child(even) { background: #f8f9fa; }
.totals { display: flex; justify-content: flex-end; margin-top: 3mm; }
.totals-table { width: 55%; }
.totals-table td { padding: 1.5mm 3mm; font-size: 9.5pt; }
.totals-table .total-row { font-weight: bold; font-size: 12pt; color: #2c3e50; border-top: 2px solid #2c3e50; }
.totals-table .label { text-align: right; padding-right: 4mm; }
.totals-table .value { text-align: right; }
.amount-words { margin-top: 4mm; padding: 3mm; background: #f0f4f8; border-radius: 2mm; font-size: 9pt; }
.amount-words strong { color: #2c3e50; }
.payment-status { margin-top: 4mm; display: flex; gap: 4mm; }
.status-badge { display: inline-block; padding: 1.5mm 4mm; border-radius: 3mm; font-size: 8.5pt; font-weight: bold; text-transform: uppercase; letter-spacing: 0.5px; }
.status-paid { background: #d4edda; color: #155724; border: 1px solid #c3e6cb; }
.status-cod { background: #fff3cd; color: #856404; border: 1px solid #ffeeba; }
.status-partial { background: #cce5ff; color: #004085; border: 1px solid #b8daff; }
.footer { margin-top: 8mm; padding-top: 4mm; border-top: 1px solid #e0e0e0; display: flex; justify-content: space-between; font-size: 8pt; color: #999; }
.signature { margin-top: 12mm; text-align: right; }
.signature-line { border-top: 1px solid #333; width: 50mm; display: inline-block; margin-top: 10mm; }
.signature-label { font-size: 8pt; color: #666; margin-top: 1mm; }
@media print { body { -webkit-print-color-adjust: exact; print-color-adjust: exact; } }
</style></head>
<body>
<div class="invoice">
    <div class="header">
        <div>
            <div class="company-name">${shop?.name || "Store"}</div>
            <div class="company-details">
                ${storeAddr.address1 ? `${storeAddr.address1}<br>` : ""}
                ${storeAddr.address2 ? `${storeAddr.address2}<br>` : ""}
                ${[storeAddr.city, storeAddr.province, storeAddr.zip].filter(Boolean).join(", ")}
                ${storeAddr.phone ? `<br>Phone: ${storeAddr.phone}` : ""}
            </div>
        </div>
        <div class="invoice-title">
            <h2>Tax Invoice</h2>
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
                <th style="width:19%;text-align:right">Amount</th>
            </tr>
        </thead>
        <tbody>
            ${productRows}
        </tbody>
    </table>

    <div class="totals">
        <table class="totals-table">
            <tr>
                <td class="label">Subtotal:</td>
                <td class="value">${fmt(totalAmount)}</td>
            </tr>
            <tr>
                <td class="label">Shipping:</td>
                <td class="value">${fmt(0)}</td>
            </tr>
            <tr class="total-row">
                <td class="label" style="padding-top:2mm">Grand Total:</td>
                <td class="value" style="padding-top:2mm">${fmt(totalAmount)}</td>
            </tr>
        </table>
    </div>

    <div class="amount-words">
        <strong>Amount in words:</strong> ${numberToWords(totalAmount)}
    </div>

    <div class="payment-status">
        ${outstandingAmount > 0
            ? `<span class="status-badge status-cod">COD — Amount Due: ${fmt(outstandingAmount)}</span>`
            : `<span class="status-badge status-paid">Paid — ${fmt(paidAmount)}</span>`
        }
    </div>

    <div class="signature">
        <div class="signature-line"></div>
        <div class="signature-label">Authorized Signature</div>
    </div>

    <div class="footer">
        <span>Invoice ${order.name} · ${orderDate}</span>
        <span>Thank you for your business!</span>
    </div>
</div>
<script>window.onload=function(){window.print();};</script>
</body></html>`;
}

/**
 * Open a print window with the invoice.
 *
 * @param {Object} params - { order, shop }
 */
export function printInvoice(params) {
    const html = generateInvoiceHtml(params);
    const w = window.open("", "_blank", "width=800,height=1000");
    if (w) { w.document.write(html); w.document.close(); }
}
