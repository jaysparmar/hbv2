import prisma from "../db.server";

export const PRINT_SETTING_KEYS = [
    "label_header", "label_bnpl_line1", "label_bnpl_line2", "label_biller_id",
    "label_from_name", "label_from_address1", "label_from_address2",
    "label_from_city", "label_from_province", "label_from_zip", "label_from_phone",
    "invoice_company_name", "invoice_title", "invoice_gstin",
    "invoice_footer", "invoice_terms",
    "invoice_from_address1", "invoice_from_address2",
    "invoice_from_city", "invoice_from_province", "invoice_from_zip",
    "invoice_from_phone", "invoice_from_email", "invoice_signature",
];

export async function getPrintSettings() {
    const rows = await prisma.setting.findMany({
        where: { key: { in: PRINT_SETTING_KEYS } },
    });
    const map = {};
    rows.forEach(r => { map[r.key] = r.value; });
    return map;
}
