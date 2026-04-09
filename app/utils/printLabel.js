/**
 * Shared print label utility.
 * Generates HTML for a shipping label and opens a print window.
 * Supports printSettings overrides from the database.
 */

export function numberToWords(num) {
  const ones = ["", "ONE", "TWO", "THREE", "FOUR", "FIVE", "SIX", "SEVEN", "EIGHT", "NINE",
    "TEN", "ELEVEN", "TWELVE", "THIRTEEN", "FOURTEEN", "FIFTEEN", "SIXTEEN", "SEVENTEEN", "EIGHTEEN", "NINETEEN"];
  const tens = ["", "", "TWENTY", "THIRTY", "FORTY", "FIFTY", "SIXTY", "SEVENTY", "EIGHTY", "NINETY"];
  function convert(n) {
    if (n === 0) return "";
    if (n < 20) return ones[n];
    if (n < 100) return tens[Math.floor(n / 10)] + (n % 10 ? " " + ones[n % 10] : "");
    if (n < 1000) return ones[Math.floor(n / 100)] + " HUNDRED" + (n % 100 ? " AND " + convert(n % 100) : "");
    if (n < 100000) return convert(Math.floor(n / 1000)) + " THOUSAND" + (n % 1000 ? " " + convert(n % 1000) : "");
    return convert(Math.floor(n / 100000)) + " LAKH" + (n % 100000 ? " " + convert(n % 100000) : "");
  }
  return (convert(Math.round(num)) || "ZERO") + " ONLY";
}

/**
 * Generate the full HTML document for a shipping label.
 *
 * @param {Object} params
 * @param {Object} params.order          - Shopify order object
 * @param {Object} params.shop           - Shopify shop object
 * @param {Object} params.parcel         - Parcel record
 * @param {Object} [params.printSettings] - Optional print settings from DB
 * @returns {string} Full HTML document string
 */
export function generateLabelHtml({ order, shop, parcel, printSettings = {} }) {
  const s = printSettings;
  const outstandingAmount = parseFloat(order.totalOutstandingSet?.shopMoney?.amount || 0);
  const isCOD = outstandingAmount > 0;
  const currency = order.totalPriceSet.shopMoney.currencyCode;
  const addr = order.shippingAddress || {};
  const cName = order.customer
    ? `${order.customer.firstName || ""} ${order.customer.lastName || ""}`.trim()
    : "";
  const customerPhone = addr.phone || order.customer?.defaultPhoneNumber?.phoneNumber || "";
  const orderDate = new Date(order.createdAt).toLocaleDateString("en-IN");
  const products = order.lineItems.edges.map(({ node }) => node);
  if (parcel?.addons) {
      parcel.addons.forEach(pa => {
          products.push({
              title: `${pa.addon.name} (Free Add-on)`,
              quantity: pa.quantity,
              originalTotalSet: { shopMoney: { amount: "0.00", currencyCode: currency } }
          });
      });
  }
  const fmt = (amt) => new Intl.NumberFormat("en-IN", { style: "currency", currency }).format(amt);

  // Use settings overrides or fall back to shop data
  const headerText = s.label_header || "ADVAIT ENTERPRISE" || "SHIPPING LABEL";
  const bnplLine1 = s.label_bnpl_line1 || "BOOKED UNDER BNPL";
  const bnplLine2 = s.label_bnpl_line2 || "";
  const billerId = s.label_biller_id || "";
  const fromName = s.label_from_name || "ADVAIT ENTERPRISE" || "";
  const storeAddr = {
    address1: s.label_from_address1 || shop?.billingAddress?.address1 || "",
    address2: s.label_from_address2 || shop?.billingAddress?.address2 || "",
    city: s.label_from_city || shop?.billingAddress?.city || "",
    province: s.label_from_province || shop?.billingAddress?.province || "",
    zip: s.label_from_zip || shop?.billingAddress?.zip || "",
    phone: s.label_from_phone || shop?.billingAddress?.phone || "",
  };

  return `<!DOCTYPE html>
<html><head>
<meta charset="utf-8">
<title>Label - ${order.name}</title>
<style>
@page { size: 105mm 148mm; margin: 3mm; }
* { box-sizing: border-box; margin: 0; padding: 0; }
body { font-family: Arial, sans-serif; font-size: 8.5pt; width: 99mm; }
.label { border: 1.5pt solid #000; padding: 3mm; width: 99mm; min-height: 140mm; }
.header { background: #000; color: #fff; text-align: center; padding: 2mm 1mm; font-size: 10pt; font-weight: bold; margin-bottom: 2mm; }
.cod-box { border: 2pt solid #000; padding: 2mm; margin-bottom: 2mm; text-align: center; }
.cod-amount { font-size: 13pt; font-weight: bold; margin: 1mm 0; }
.cod-words { font-size: 7pt; }
.row { display: flex; gap: 2mm; }
.half { flex: 1; }
.sec-title { font-weight: bold; border-bottom: 0.5pt solid #000; margin-bottom: 1mm; font-size: 7.5pt; }
.addr-name { font-weight: bold; font-size: 9.5pt; }
.divider { border-top: 0.5pt solid #000; margin: 2mm 0; }
.awb-box { text-align: center; border: 1pt solid #000; padding: 2mm; margin-bottom: 2mm; }
.awb { font-size: 13pt; font-weight: bold; letter-spacing: 1pt; }
.meta { display: flex; justify-content: space-between; font-size: 7.5pt; margin-bottom: 1mm; flex-wrap: wrap; gap: 0.5mm; }
.bnpl-box { border: 1pt solid #000; padding: 2mm; margin-bottom: 2mm; text-align: center; }
.bnpl-main { font-weight: bold; font-size: 9pt; }
.bnpl-sub { font-size: 7.5pt; margin-top: 0.5mm; }
table { width: 100%; border-collapse: collapse; font-size: 7.5pt; }
th { background: #eee; border: 0.5pt solid #000; padding: 1mm; text-align: left; }
td { border: 0.5pt solid #000; padding: 1mm; }
.footer { display: flex; justify-content: space-between; font-size: 7.5pt; margin-top: 1mm; flex-wrap: wrap; gap: 0.5mm; }
@media print { body { -webkit-print-color-adjust: exact; print-color-adjust: exact; } }
</style></head>
<body><div class="label">
<div class="header">${headerText}</div>
<div class="bnpl-box">
  <div class="bnpl-main">${bnplLine1}${isCOD ? " (SP-COD)" : ""}</div>
  ${bnplLine2 ? `<div class="bnpl-sub">${bnplLine2}</div>` : ""}
  ${billerId ? `<div class="bnpl-sub">Biller ID: ${billerId}</div>` : ""}
</div>
${isCOD ? `
<div class="cod-box">
  <div style="font-weight:bold;font-size:8pt;">COD COLLECT AMOUNT</div>
  <div class="cod-amount">${fmt(outstandingAmount)}</div>
  <div class="cod-words">Words: ${numberToWords(outstandingAmount)}</div>
</div>` : ""}
<div class="row">
  <div class="half">
    <div class="sec-title">To,</div>
    <div class="addr-name">${cName}</div>
    ${addr.address1 ? `<div>${addr.address1}</div>` : ""}
    ${addr.address2 ? `<div>${addr.address2}</div>` : ""}
    <div>${[addr.city, addr.province, addr.zip].filter(Boolean).join(", ")}</div>
    <div>${addr.country || ""}</div>
    ${customerPhone ? `<div>Ph: ${customerPhone}</div>` : ""}
  </div>
  <div class="half">
    <div class="sec-title">From,</div>
    <div class="addr-name">${fromName}</div>
    ${storeAddr.address1 ? `<div>${storeAddr.address1}</div>` : ""}
    ${storeAddr.address2 ? `<div>${storeAddr.address2}</div>` : ""}
    <div>${[storeAddr.city, storeAddr.province, storeAddr.zip].filter(Boolean).join(", ")}</div>
    ${storeAddr.phone ? `<div>Mo: ${storeAddr.phone}</div>` : ""}
  </div>
</div>
<div class="divider"></div>
<div class="awb-box"><div class="awb">${parcel.awbNumber || "—"}</div></div>
<div class="meta">
  <span><b>Pay Mode:</b> ${isCOD ? "COD" : "PREPAID"}</span>
  <span><b>Order:</b> ${order.name}</span>
  <span><b>Date:</b> ${orderDate}</span>
  <span><b>Carrier:</b> ${parcel.carrierName}</span>
</div>
<div class="divider"></div>
<table>
  <thead><tr><th>Product</th><th>Qty</th><th>Price</th></tr></thead>
  <tbody>
    ${products.map(p => `<tr><td>${p.title}</td><td>${p.quantity}</td><td>${fmt(p.originalTotalSet.shopMoney.amount)}</td></tr>`).join("")}
  </tbody>
</table>
<div class="footer">
  <span>Total: ${fmt(order.totalPriceSet.shopMoney.amount)}</span>
  <span>${parcel.length}x${parcel.width}x${parcel.height}cm · ${parcel.weight}kg</span>
</div>
</div>
<script>window.onload=function(){window.print();};</script>
</body></html>`;
}

/**
 * Open a print window with the shipping label.
 *
 * @param {Object} params - same as generateLabelHtml
 */
export function printLabel(params) {
  const html = generateLabelHtml(params);
  const w = window.open("", "_blank", "width=500,height=720");
  if (w) { w.document.write(html); w.document.close(); }
}
