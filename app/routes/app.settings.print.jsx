import { useLoaderData, useSubmit, useNavigation, useActionData } from "@remix-run/react";
import {
    Page, Layout, Card, BlockStack, Text, FormLayout, TextField, Banner, Divider, DropZone, Thumbnail, Button
} from "@shopify/polaris";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { useState, useCallback, useEffect } from "react";

const KEYS = {
    // Shipping Label
    label_header: "label_header",
    label_bnpl_line1: "label_bnpl_line1",
    label_bnpl_line2: "label_bnpl_line2",
    label_biller_id: "label_biller_id",
    label_from_name: "label_from_name",
    label_from_address1: "label_from_address1",
    label_from_address2: "label_from_address2",
    label_from_city: "label_from_city",
    label_from_province: "label_from_province",
    label_from_zip: "label_from_zip",
    label_from_phone: "label_from_phone",
    // Invoice
    invoice_company_name: "invoice_company_name",
    invoice_title: "invoice_title",
    invoice_gstin: "invoice_gstin",
    invoice_footer: "invoice_footer",
    invoice_terms: "invoice_terms",
    invoice_from_address1: "invoice_from_address1",
    invoice_from_address2: "invoice_from_address2",
    invoice_from_city: "invoice_from_city",
    invoice_from_province: "invoice_from_province",
    invoice_from_zip: "invoice_from_zip",
    invoice_from_phone: "invoice_from_phone",
    invoice_from_email: "invoice_from_email",
    invoice_signature: "invoice_signature",
};

async function getSetting(key) {
    const row = await prisma.setting.findUnique({ where: { key } });
    return row?.value || "";
}

async function upsertSetting(key, value) {
    await prisma.setting.upsert({
        where: { key },
        update: { value },
        create: { key, value },
    });
}

export const loader = async ({ request }) => {
    await authenticate.admin(request);
    const settings = {};
    await Promise.all(
        Object.entries(KEYS).map(async ([field, key]) => {
            settings[field] = await getSetting(key);
        })
    );
    return settings;
};

export const action = async ({ request }) => {
    await authenticate.admin(request);
    const formData = await request.formData();
    await Promise.all(
        Object.entries(KEYS).map(([field, key]) =>
            upsertSetting(key, formData.get(field) || "")
        )
    );
    return { success: true };
};

export default function PrintSettingsPage() {
    const data = useLoaderData();
    const actionData = useActionData();
    const submit = useSubmit();
    const navigation = useNavigation();
    const isSaving = navigation.state === "submitting";

    // Shipping label fields
    const [labelHeader, setLabelHeader] = useState(data.label_header);
    const [labelBnplLine1, setLabelBnplLine1] = useState(data.label_bnpl_line1);
    const [labelBnplLine2, setLabelBnplLine2] = useState(data.label_bnpl_line2);
    const [labelBillerId, setLabelBillerId] = useState(data.label_biller_id);
    const [labelFromName, setLabelFromName] = useState(data.label_from_name);
    const [labelFromAddr1, setLabelFromAddr1] = useState(data.label_from_address1);
    const [labelFromAddr2, setLabelFromAddr2] = useState(data.label_from_address2);
    const [labelFromCity, setLabelFromCity] = useState(data.label_from_city);
    const [labelFromProvince, setLabelFromProvince] = useState(data.label_from_province);
    const [labelFromZip, setLabelFromZip] = useState(data.label_from_zip);
    const [labelFromPhone, setLabelFromPhone] = useState(data.label_from_phone);

    // Invoice fields
    const [invoiceCompanyName, setInvoiceCompanyName] = useState(data.invoice_company_name);
    const [invoiceTitle, setInvoiceTitle] = useState(data.invoice_title);
    const [invoiceGstin, setInvoiceGstin] = useState(data.invoice_gstin);
    const [invoiceFooter, setInvoiceFooter] = useState(data.invoice_footer);
    const [invoiceTerms, setInvoiceTerms] = useState(data.invoice_terms);
    const [invoiceFromAddr1, setInvoiceFromAddr1] = useState(data.invoice_from_address1);
    const [invoiceFromAddr2, setInvoiceFromAddr2] = useState(data.invoice_from_address2);
    const [invoiceFromCity, setInvoiceFromCity] = useState(data.invoice_from_city);
    const [invoiceFromProvince, setInvoiceFromProvince] = useState(data.invoice_from_province);
    const [invoiceFromZip, setInvoiceFromZip] = useState(data.invoice_from_zip);
    const [invoiceFromPhone, setInvoiceFromPhone] = useState(data.invoice_from_phone);
    const [invoiceFromEmail, setInvoiceFromEmail] = useState(data.invoice_from_email);
    const [invoiceSignature, setInvoiceSignature] = useState(data.invoice_signature);

    const [showBanner, setShowBanner] = useState(false);

    useEffect(() => {
        setLabelHeader(data.label_header);
        setLabelBnplLine1(data.label_bnpl_line1);
        setLabelBnplLine2(data.label_bnpl_line2);
        setLabelBillerId(data.label_biller_id);
        setLabelFromName(data.label_from_name);
        setLabelFromAddr1(data.label_from_address1);
        setLabelFromAddr2(data.label_from_address2);
        setLabelFromCity(data.label_from_city);
        setLabelFromProvince(data.label_from_province);
        setLabelFromZip(data.label_from_zip);
        setLabelFromPhone(data.label_from_phone);
        setInvoiceCompanyName(data.invoice_company_name);
        setInvoiceTitle(data.invoice_title);
        setInvoiceGstin(data.invoice_gstin);
        setInvoiceFooter(data.invoice_footer);
        setInvoiceTerms(data.invoice_terms);
        setInvoiceFromAddr1(data.invoice_from_address1);
        setInvoiceFromAddr2(data.invoice_from_address2);
        setInvoiceFromCity(data.invoice_from_city);
        setInvoiceFromProvince(data.invoice_from_province);
        setInvoiceFromZip(data.invoice_from_zip);
        setInvoiceFromPhone(data.invoice_from_phone);
        setInvoiceFromEmail(data.invoice_from_email);
        setInvoiceSignature(data.invoice_signature);
    }, [data]);

    useEffect(() => {
        if (actionData?.success) {
            setShowBanner(true);
            const timer = setTimeout(() => setShowBanner(false), 4000);
            return () => clearTimeout(timer);
        }
    }, [actionData]);

    const handleSave = useCallback(() => {
        submit(
            {
                label_header: labelHeader,
                label_bnpl_line1: labelBnplLine1,
                label_bnpl_line2: labelBnplLine2,
                label_biller_id: labelBillerId,
                label_from_name: labelFromName,
                label_from_address1: labelFromAddr1,
                label_from_address2: labelFromAddr2,
                label_from_city: labelFromCity,
                label_from_province: labelFromProvince,
                label_from_zip: labelFromZip,
                label_from_phone: labelFromPhone,
                invoice_company_name: invoiceCompanyName,
                invoice_title: invoiceTitle,
                invoice_gstin: invoiceGstin,
                invoice_footer: invoiceFooter,
                invoice_terms: invoiceTerms,
                invoice_from_address1: invoiceFromAddr1,
                invoice_from_address2: invoiceFromAddr2,
                invoice_from_city: invoiceFromCity,
                invoice_from_province: invoiceFromProvince,
                invoice_from_zip: invoiceFromZip,
                invoice_from_phone: invoiceFromPhone,
                invoice_from_email: invoiceFromEmail,
                invoice_signature: invoiceSignature,
            },
            { method: "post" }
        );
    }, [
        labelHeader, labelBnplLine1, labelBnplLine2, labelBillerId,
        labelFromName, labelFromAddr1, labelFromAddr2, labelFromCity, labelFromProvince, labelFromZip, labelFromPhone,
        invoiceCompanyName, invoiceTitle, invoiceGstin, invoiceFooter, invoiceTerms,
        invoiceFromAddr1, invoiceFromAddr2, invoiceFromCity, invoiceFromProvince, invoiceFromZip, invoiceFromPhone, invoiceFromEmail, invoiceSignature,
        submit,
    ]);

    const handleDrop = useCallback(
        (_dropFiles, acceptedFiles, _rejectedFiles) => {
            const file = acceptedFiles[0];
            if (file) {
                const reader = new FileReader();
                reader.onloadend = () => {
                    setInvoiceSignature(reader.result);
                };
                reader.readAsDataURL(file);
            }
        },
        [],
    );

    return (
        <Page
            backAction={{ content: "Settings", url: "/app/settings" }}
            title="Print Settings"
            subtitle="Configure shipping label and invoice templates."
            primaryAction={{
                content: "Save changes",
                onAction: handleSave,
                loading: isSaving,
            }}
        >
            <Layout>
                {showBanner && (
                    <Layout.Section>
                        <Banner tone="success" title="Settings saved successfully." onDismiss={() => setShowBanner(false)} />
                    </Layout.Section>
                )}

                {/* ─── Shipping Label Settings ─── */}
                <Layout.Section>
                    <Card>
                        <BlockStack gap="500">
                            <BlockStack gap="100">
                                <Text variant="headingMd" as="h2">Shipping Label</Text>
                                <Text as="p" tone="subdued" variant="bodySm">
                                    Customize the shipping label header, booking details, and sender (from) address.
                                </Text>
                            </BlockStack>
                            <Divider />
                            <FormLayout>
                                <TextField
                                    label="Label Header"
                                    value={labelHeader}
                                    onChange={setLabelHeader}
                                    placeholder="Leave blank to use store name"
                                    autoComplete="off"
                                    helpText="Display name at the top of the shipping label."
                                />
                                <FormLayout.Group>
                                    <TextField
                                        label="BNPL Line 1"
                                        value={labelBnplLine1}
                                        onChange={setLabelBnplLine1}
                                        placeholder="BOOKED UNDER BNPL"
                                        autoComplete="off"
                                    />
                                    <TextField
                                        label="BNPL Line 2"
                                        value={labelBnplLine2}
                                        onChange={setLabelBnplLine2}
                                        placeholder="BHUJ HPO - 370001(GUJ-K)"
                                        autoComplete="off"
                                    />
                                </FormLayout.Group>
                                <TextField
                                    label="Biller ID"
                                    value={labelBillerId}
                                    onChange={setLabelBillerId}
                                    placeholder="0000058749"
                                    autoComplete="off"
                                />
                            </FormLayout>
                        </BlockStack>
                    </Card>
                </Layout.Section>

                <Layout.Section>
                    <Card>
                        <BlockStack gap="500">
                            <BlockStack gap="100">
                                <Text variant="headingMd" as="h2">Label – Sender Address</Text>
                                <Text as="p" tone="subdued" variant="bodySm">
                                    Override the "From" address on shipping labels. If blank, the store billing address is used.
                                </Text>
                            </BlockStack>
                            <Divider />
                            <FormLayout>
                                <TextField label="From Name" value={labelFromName} onChange={setLabelFromName} autoComplete="off" placeholder="Store name or sender name" />
                                <FormLayout.Group>
                                    <TextField label="Address Line 1" value={labelFromAddr1} onChange={setLabelFromAddr1} autoComplete="off" />
                                    <TextField label="Address Line 2" value={labelFromAddr2} onChange={setLabelFromAddr2} autoComplete="off" />
                                </FormLayout.Group>
                                <FormLayout.Group>
                                    <TextField label="City" value={labelFromCity} onChange={setLabelFromCity} autoComplete="off" />
                                    <TextField label="Province / State" value={labelFromProvince} onChange={setLabelFromProvince} autoComplete="off" />
                                </FormLayout.Group>
                                <FormLayout.Group>
                                    <TextField label="ZIP / Postal Code" value={labelFromZip} onChange={setLabelFromZip} autoComplete="off" />
                                    <TextField label="Phone" value={labelFromPhone} onChange={setLabelFromPhone} autoComplete="off" />
                                </FormLayout.Group>
                            </FormLayout>
                        </BlockStack>
                    </Card>
                </Layout.Section>

                {/* ─── Invoice Settings ─── */}
                <Layout.Section>
                    <Card>
                        <BlockStack gap="500">
                            <BlockStack gap="100">
                                <Text variant="headingMd" as="h2">Invoice</Text>
                                <Text as="p" tone="subdued" variant="bodySm">
                                    Customize the invoice template — company name, title, tax ID, footer, and terms.
                                </Text>
                            </BlockStack>
                            <Divider />
                            <FormLayout>
                                <FormLayout.Group>
                                    <TextField
                                        label="Company / Store Name"
                                        value={invoiceCompanyName}
                                        onChange={setInvoiceCompanyName}
                                        placeholder="Leave blank to use Shopify store name"
                                        autoComplete="off"
                                    />
                                    <TextField
                                        label="Invoice Title"
                                        value={invoiceTitle}
                                        onChange={setInvoiceTitle}
                                        placeholder="Tax Invoice"
                                        autoComplete="off"
                                        helpText="The heading shown on the invoice, e.g. 'Tax Invoice', 'Proforma Invoice'."
                                    />
                                </FormLayout.Group>
                                <TextField
                                    label="GSTIN / Tax Number"
                                    value={invoiceGstin}
                                    onChange={setInvoiceGstin}
                                    placeholder="22AAAAA0000A1Z5"
                                    autoComplete="off"
                                    helpText="Shown below the company name on the invoice."
                                />
                                <TextField
                                    label="Footer Text"
                                    value={invoiceFooter}
                                    onChange={setInvoiceFooter}
                                    placeholder="Thank you for your business!"
                                    autoComplete="off"
                                />
                                <TextField
                                    label="Terms & Conditions"
                                    value={invoiceTerms}
                                    onChange={setInvoiceTerms}
                                    multiline={3}
                                    autoComplete="off"
                                    helpText="Shown at the bottom of the invoice. Supports multiple lines."
                                />
                                <BlockStack gap="200">
                                    <Text variant="headingSm" as="h3">Authorized Signature</Text>
                                    <Text tone="subdued" as="p">Recommended dimensions: 200 x 80 pixels. Format: PNG.</Text>
                                    {invoiceSignature ? (
                                        <Card background="bg-surface-secondary">
                                            <BlockStack gap="400" inlineAlign="center">
                                                <img src={invoiceSignature} alt="Uploaded signature" style={{ maxHeight: '100px', maxWidth: '300px', objectFit: 'contain' }} />
                                                <Button tone="critical" onClick={() => setInvoiceSignature("")}>
                                                    Remove Signature
                                                </Button>
                                            </BlockStack>
                                        </Card>
                                    ) : (
                                        <DropZone accept="image/png, image/jpeg" type="image" onDrop={handleDrop} allowMultiple={false}>
                                            <DropZone.FileUpload actionHint="Accepts .png and .jpg" />
                                        </DropZone>
                                    )}
                                </BlockStack>
                            </FormLayout>
                        </BlockStack>
                    </Card>
                </Layout.Section>

                <Layout.Section>
                    <Card>
                        <BlockStack gap="500">
                            <BlockStack gap="100">
                                <Text variant="headingMd" as="h2">Invoice – Sender Address</Text>
                                <Text as="p" tone="subdued" variant="bodySm">
                                    Override the company address on invoices. If blank, the store billing address is used.
                                </Text>
                            </BlockStack>
                            <Divider />
                            <FormLayout>
                                <FormLayout.Group>
                                    <TextField label="Address Line 1" value={invoiceFromAddr1} onChange={setInvoiceFromAddr1} autoComplete="off" />
                                    <TextField label="Address Line 2" value={invoiceFromAddr2} onChange={setInvoiceFromAddr2} autoComplete="off" />
                                </FormLayout.Group>
                                <FormLayout.Group>
                                    <TextField label="City" value={invoiceFromCity} onChange={setInvoiceFromCity} autoComplete="off" />
                                    <TextField label="Province / State" value={invoiceFromProvince} onChange={setInvoiceFromProvince} autoComplete="off" />
                                </FormLayout.Group>
                                <FormLayout.Group>
                                    <TextField label="ZIP / Postal Code" value={invoiceFromZip} onChange={setInvoiceFromZip} autoComplete="off" />
                                    <TextField label="Phone" value={invoiceFromPhone} onChange={setInvoiceFromPhone} autoComplete="off" />
                                </FormLayout.Group>
                                <TextField label="Email" value={invoiceFromEmail} onChange={setInvoiceFromEmail} autoComplete="off" />
                            </FormLayout>
                        </BlockStack>
                    </Card>
                </Layout.Section>
            </Layout>
        </Page>
    );
}
