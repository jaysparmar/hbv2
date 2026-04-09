import { useLoaderData, useSubmit, useNavigation, useActionData } from "@remix-run/react";
import {
    Page,
    Layout,
    Card,
    BlockStack,
    Text,
    FormLayout,
    TextField,
    Button,
    Banner,
    InlineStack,
    Badge,
    Box,
    Select,
    Divider,
    Tooltip,
} from "@shopify/polaris";
import { ClipboardIcon, RefreshIcon } from "@shopify/polaris-icons";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { useState, useCallback, useEffect } from "react";

const KEYS = {
    gateway: "payment_gateway",
    razorpay_key_id: "razorpay_key_id",
    razorpay_key_secret: "razorpay_key_secret",
    razorpay_webhook_secret: "razorpay_webhook_secret",
    razorpay_mode: "razorpay_mode",
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
    const origin = new URL(request.url).origin;
    const [gateway, keyId, keySecret, webhookSecret, mode] = await Promise.all([
        getSetting(KEYS.gateway),
        getSetting(KEYS.razorpay_key_id),
        getSetting(KEYS.razorpay_key_secret),
        getSetting(KEYS.razorpay_webhook_secret),
        getSetting(KEYS.razorpay_mode),
    ]);
    return {
        gateway: gateway || "razorpay",
        keyId,
        keySecret,
        webhookSecret,
        mode: mode || "test",
        webhookUrl: `${origin}/webhooks/razorpay`,
    };
};

export const action = async ({ request }) => {
    await authenticate.admin(request);
    const formData = await request.formData();
    await Promise.all([
        upsertSetting(KEYS.gateway, formData.get("gateway") || "razorpay"),
        upsertSetting(KEYS.razorpay_key_id, formData.get("keyId") || ""),
        upsertSetting(KEYS.razorpay_key_secret, formData.get("keySecret") || ""),
        upsertSetting(KEYS.razorpay_webhook_secret, formData.get("webhookSecret") || ""),
        upsertSetting(KEYS.razorpay_mode, formData.get("mode") || "test"),
    ]);
    return { success: true };
};

function generateRandomSecret() {
    const arr = new Uint8Array(32);
    window.crypto.getRandomValues(arr);
    return Array.from(arr).map((b) => b.toString(16).padStart(2, "0")).join("");
}

export default function PaymentSettingsPage() {
    const data = useLoaderData();
    const actionData = useActionData();
    const submit = useSubmit();
    const navigation = useNavigation();
    const isSaving = navigation.state === "submitting";

    const [gateway, setGateway] = useState(data.gateway);
    const [keyId, setKeyId] = useState(data.keyId);
    const [keySecret, setKeySecret] = useState(data.keySecret);
    const [webhookSecret, setWebhookSecret] = useState(data.webhookSecret);
    const [mode, setMode] = useState(data.mode);
    const [showBanner, setShowBanner] = useState(false);
    const [urlCopied, setUrlCopied] = useState(false);

    useEffect(() => {
        setGateway(data.gateway);
        setKeyId(data.keyId);
        setKeySecret(data.keySecret);
        setWebhookSecret(data.webhookSecret);
        setMode(data.mode);
    }, [data]);

    useEffect(() => {
        if (actionData?.success) {
            setShowBanner(true);
            const timer = setTimeout(() => setShowBanner(false), 4000);
            return () => clearTimeout(timer);
        }
    }, [actionData]);

    const handleSave = useCallback(() => {
        submit({ gateway, keyId, keySecret, webhookSecret, mode }, { method: "post" });
    }, [gateway, keyId, keySecret, webhookSecret, mode, submit]);

    const handleCopyUrl = useCallback(() => {
        navigator.clipboard.writeText(data.webhookUrl).then(() => {
            setUrlCopied(true);
            setTimeout(() => setUrlCopied(false), 2000);
        });
    }, [data.webhookUrl]);

    const handleGenerateSecret = useCallback(() => {
        setWebhookSecret(generateRandomSecret());
    }, []);

    const gatewayOptions = [{ label: "Razorpay", value: "razorpay" }];
    const modeOptions = [
        { label: "Test (Sandbox)", value: "test" },
        { label: "Live (Production)", value: "live" },
    ];

    return (
        <Page
            backAction={{ content: "Settings", url: "/app/settings" }}
            title="Payment Gateway"
            subtitle="Configure your payment gateway integration."
            primaryAction={{
                content: "Save changes",
                onAction: handleSave,
                loading: isSaving,
            }}
        >
            <Layout>
                {showBanner && (
                    <Layout.Section>
                        <Banner
                            tone="success"
                            title="Settings saved successfully."
                            onDismiss={() => setShowBanner(false)}
                        />
                    </Layout.Section>
                )}

                {/* Gateway Selection */}
                <Layout.Section>
                    <Card>
                        <BlockStack gap="400">
                            <InlineStack align="space-between" blockAlign="center">
                                <BlockStack gap="100">
                                    <Text variant="headingMd" as="h2">Gateway Selection</Text>
                                    <Text as="p" tone="subdued" variant="bodySm">
                                        Choose the payment gateway for processing transactions.
                                    </Text>
                                </BlockStack>
                                <Badge tone="info">More coming soon</Badge>
                            </InlineStack>
                            <Divider />
                            <Select
                                label="Active Payment Gateway"
                                options={gatewayOptions}
                                value={gateway}
                                onChange={setGateway}
                            />
                        </BlockStack>
                    </Card>
                </Layout.Section>

                {gateway === "razorpay" && (
                    <>
                        {/* Webhook Endpoint */}
                        <Layout.Section>
                            <Card>
                                <BlockStack gap="400">
                                    <BlockStack gap="100">
                                        <Text variant="headingMd" as="h2">Webhook Endpoint</Text>
                                        <Text as="p" tone="subdued" variant="bodySm">
                                            Add this URL to your{" "}
                                            <a
                                                href="https://dashboard.razorpay.com/app/webhooks"
                                                target="_blank"
                                                rel="noopener noreferrer"
                                            >
                                                Razorpay Webhook settings
                                            </a>{" "}
                                            so Razorpay can notify your app of payment events.
                                        </Text>
                                    </BlockStack>
                                    <Divider />
                                    <TextField
                                        label="Webhook URL"
                                        value={data.webhookUrl}
                                        readOnly
                                        autoComplete="off"
                                        connectedRight={
                                            <Tooltip content={urlCopied ? "Copied!" : "Copy to clipboard"}>
                                                <Button
                                                    icon={ClipboardIcon}
                                                    onClick={handleCopyUrl}
                                                    tone={urlCopied ? "success" : undefined}
                                                >
                                                    {urlCopied ? "Copied!" : "Copy"}
                                                </Button>
                                            </Tooltip>
                                        }
                                        helpText="Paste this URL into Razorpay → Settings → Webhooks → Add New Webhook."
                                    />
                                </BlockStack>
                            </Card>
                        </Layout.Section>

                        {/* API Keys */}
                        <Layout.Section>
                            <Card>
                                <BlockStack gap="400">
                                    <InlineStack align="space-between" blockAlign="center">
                                        <BlockStack gap="100">
                                            <Text variant="headingMd" as="h2">API Keys</Text>
                                            <Text as="span" tone="subdued" variant="bodySm">
                                                Get your keys from the{" "}
                                                <a
                                                    href="https://dashboard.razorpay.com/app/keys"
                                                    target="_blank"
                                                    rel="noopener noreferrer"
                                                >
                                                    Razorpay Dashboard
                                                </a>
                                                .
                                            </Text>
                                        </BlockStack>
                                        <Select
                                            label="Mode"
                                            labelHidden
                                            options={modeOptions}
                                            value={mode}
                                            onChange={setMode}
                                        />
                                    </InlineStack>
                                    <Divider />

                                    {mode === "live" && (
                                        <Banner tone="warning">
                                            You are configuring <strong>Live (Production)</strong> keys. Real payments will be processed.
                                        </Banner>
                                    )}

                                    <FormLayout>
                                        <TextField
                                            label="Key ID"
                                            value={keyId}
                                            onChange={setKeyId}
                                            placeholder="rzp_test_XXXXXXXXXXXXXX"
                                            autoComplete="off"
                                            helpText="Starts with rzp_test_ for test mode or rzp_live_ for live mode."
                                        />
                                        <TextField
                                            label="Key Secret"
                                            type="password"
                                            value={keySecret}
                                            onChange={setKeySecret}
                                            autoComplete="new-password"
                                            helpText="Provided by Razorpay. Keep this secret — never share it publicly."
                                        />
                                        <TextField
                                            label="Webhook Secret"
                                            type="password"
                                            value={webhookSecret}
                                            onChange={setWebhookSecret}
                                            autoComplete="new-password"
                                            connectedRight={
                                                <Tooltip content="Generate a secure random secret">
                                                    <Button icon={RefreshIcon} onClick={handleGenerateSecret}>
                                                        Generate
                                                    </Button>
                                                </Tooltip>
                                            }
                                            helpText="Generate a secret here, save it, then paste the same value into Razorpay when setting up your webhook."
                                        />
                                    </FormLayout>
                                </BlockStack>
                            </Card>
                        </Layout.Section>
                    </>
                )}

                {/* Setup Guide sidebar */}
                <Layout.Section variant="oneThird">
                    <Card>
                        <BlockStack gap="300">
                            <Text variant="headingMd" as="h2">Setup Guide</Text>
                            <Divider />
                            <BlockStack gap="300">
                                {[
                                    { step: "1", text: "Log in to your Razorpay Dashboard." },
                                    { step: "2", text: "Go to Settings → API Keys → Generate Key. Copy the Key ID and Key Secret." },
                                    { step: "3", text: "Go to Settings → Webhooks → Add New Webhook. Paste the Webhook URL above." },
                                    { step: "4", text: 'Click "Generate" to create a Webhook Secret, save it here, then enter the same value in Razorpay.' },
                                    { step: "5", text: "Use Test mode during development, switch to Live when ready." },
                                ].map((item) => (
                                    <InlineStack key={item.step} gap="300" blockAlign="start">
                                        <Box
                                            background="bg-surface-secondary"
                                            paddingInline="200"
                                            paddingBlock="050"
                                            borderRadius="full"
                                            minWidth="24px"
                                        >
                                            <Text as="span" variant="bodySm" fontWeight="bold">{item.step}</Text>
                                        </Box>
                                        <Text as="span" tone="subdued" variant="bodySm">{item.text}</Text>
                                    </InlineStack>
                                ))}
                            </BlockStack>
                        </BlockStack>
                    </Card>
                </Layout.Section>
            </Layout>
        </Page>
    );
}
