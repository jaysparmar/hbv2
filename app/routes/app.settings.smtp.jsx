import { useLoaderData, useSubmit, useNavigation, useActionData } from "@remix-run/react";
import {
    Page,
    Layout,
    Card,
    BlockStack,
    Text,
    FormLayout,
    TextField,
    Select,
    Banner,
    InlineStack,
    Badge,
    Box,
    Divider,
} from "@shopify/polaris";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { useState, useCallback, useEffect } from "react";

const KEYS = {
    host: "smtp_host",
    port: "smtp_port",
    encryption: "smtp_encryption",
    username: "smtp_username",
    password: "smtp_password",
    from_name: "smtp_from_name",
    from_email: "smtp_from_email",
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
    const [host, port, encryption, username, password, from_name, from_email] = await Promise.all([
        getSetting(KEYS.host),
        getSetting(KEYS.port),
        getSetting(KEYS.encryption),
        getSetting(KEYS.username),
        getSetting(KEYS.password),
        getSetting(KEYS.from_name),
        getSetting(KEYS.from_email),
    ]);
    return { host, port, encryption, username, password, from_name, from_email };
};

export const action = async ({ request }) => {
    await authenticate.admin(request);
    const formData = await request.formData();

    await Promise.all([
        upsertSetting(KEYS.host, formData.get("host") || ""),
        upsertSetting(KEYS.port, formData.get("port") || ""),
        upsertSetting(KEYS.encryption, formData.get("encryption") || ""),
        upsertSetting(KEYS.username, formData.get("username") || ""),
        upsertSetting(KEYS.password, formData.get("password") || ""),
        upsertSetting(KEYS.from_name, formData.get("from_name") || ""),
        upsertSetting(KEYS.from_email, formData.get("from_email") || ""),
    ]);

    return { success: true };
};

const PROVIDERS = [
    { name: "Gmail", host: "smtp.gmail.com", port: "587", enc: "tls" },
    { name: "Outlook", host: "smtp.office365.com", port: "587", enc: "tls" },
    { name: "Yahoo", host: "smtp.mail.yahoo.com", port: "465", enc: "ssl" },
    { name: "SendGrid", host: "smtp.sendgrid.net", port: "587", enc: "tls" },
    { name: "Mailgun", host: "smtp.mailgun.org", port: "587", enc: "tls" },
    { name: "SES", host: "email-smtp.us-east-1.amazonaws.com", port: "587", enc: "tls" },
];

const ENC_LABEL = { tls: "TLS", ssl: "SSL", none: "None" };

export default function SmtpSettingsPage() {
    const data = useLoaderData();
    const actionData = useActionData();
    const submit = useSubmit();
    const navigation = useNavigation();
    const isSaving = navigation.state === "submitting";

    const [host, setHost] = useState(data.host);
    const [port, setPort] = useState(data.port || "587");
    const [encryption, setEncryption] = useState(data.encryption || "tls");
    const [username, setUsername] = useState(data.username);
    const [password, setPassword] = useState(data.password);
    const [from_name, setFromName] = useState(data.from_name);
    const [from_email, setFromEmail] = useState(data.from_email);
    const [showBanner, setShowBanner] = useState(false);

    useEffect(() => {
        setHost(data.host);
        setPort(data.port || "587");
        setEncryption(data.encryption || "tls");
        setUsername(data.username);
        setPassword(data.password);
        setFromName(data.from_name);
        setFromEmail(data.from_email);
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
            { host, port, encryption, username, password, from_name, from_email },
            { method: "post" }
        );
    }, [host, port, encryption, username, password, from_name, from_email, submit]);

    const applyProvider = useCallback((provider) => {
        setHost(provider.host);
        setPort(provider.port);
        setEncryption(provider.enc);
    }, []);

    const encryptionOptions = [
        { label: "TLS (Recommended)", value: "tls" },
        { label: "SSL", value: "ssl" },
        { label: "None", value: "none" },
    ];

    return (
        <Page
            backAction={{ content: "Settings", url: "/app/settings" }}
            title="SMTP Settings"
            subtitle="Configure the email server used to send notifications."
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

                {/* Server Configuration */}
                <Layout.Section>
                    <Card>
                        <BlockStack gap="500">
                            <BlockStack gap="100">
                                <Text variant="headingMd" as="h2">Server Configuration</Text>
                                <Text as="p" tone="subdued" variant="bodySm">
                                    Connection settings for your outgoing mail server.
                                </Text>
                            </BlockStack>
                            <Divider />
                            <FormLayout>
                                <FormLayout.Group>
                                    <TextField
                                        label="SMTP Host"
                                        value={host}
                                        onChange={setHost}
                                        placeholder="smtp.gmail.com"
                                        autoComplete="off"
                                        helpText="The hostname or IP address of your mail server."
                                    />
                                    <TextField
                                        label="Port"
                                        type="number"
                                        value={port}
                                        onChange={setPort}
                                        placeholder="587"
                                        autoComplete="off"
                                        helpText="Common ports: 587 (TLS), 465 (SSL), 25 (None)."
                                    />
                                </FormLayout.Group>
                                <Select
                                    label="Encryption"
                                    options={encryptionOptions}
                                    value={encryption}
                                    onChange={setEncryption}
                                    helpText="TLS is recommended for most providers."
                                />
                                <FormLayout.Group>
                                    <TextField
                                        label="Username"
                                        value={username}
                                        onChange={setUsername}
                                        placeholder="you@example.com"
                                        autoComplete="off"
                                    />
                                    <TextField
                                        label="Password"
                                        type="password"
                                        value={password}
                                        onChange={setPassword}
                                        autoComplete="new-password"
                                        helpText="Use an app-specific password if 2FA is enabled."
                                    />
                                </FormLayout.Group>
                            </FormLayout>
                        </BlockStack>
                    </Card>
                </Layout.Section>

                {/* Sender Details */}
                <Layout.Section>
                    <Card>
                        <BlockStack gap="500">
                            <BlockStack gap="100">
                                <Text variant="headingMd" as="h2">Sender Details</Text>
                                <Text as="p" tone="subdued" variant="bodySm">
                                    The name and email address recipients will see.
                                </Text>
                            </BlockStack>
                            <Divider />
                            <FormLayout>
                                <FormLayout.Group>
                                    <TextField
                                        label="From Name"
                                        value={from_name}
                                        onChange={setFromName}
                                        placeholder="My Store"
                                        autoComplete="off"
                                        helpText="Displayed as the sender name in email clients."
                                    />
                                    <TextField
                                        label="From Email"
                                        type="email"
                                        value={from_email}
                                        onChange={setFromEmail}
                                        placeholder="noreply@mystore.com"
                                        autoComplete="off"
                                        helpText="Must be authorized to send from your SMTP server."
                                    />
                                </FormLayout.Group>
                            </FormLayout>
                        </BlockStack>
                    </Card>
                </Layout.Section>

                {/* Quick-fill Provider Presets (sidebar) */}
                <Layout.Section variant="oneThird">
                    <Card>
                        <BlockStack gap="400">
                            <BlockStack gap="100">
                                <Text variant="headingMd" as="h2">Provider Presets</Text>
                                <Text as="p" tone="subdued" variant="bodySm">
                                    Click a provider to auto-fill the server settings.
                                </Text>
                            </BlockStack>
                            <Divider />
                            <BlockStack gap="200">
                                {PROVIDERS.map((p) => (
                                    <Box
                                        key={p.name}
                                        as="button"
                                        width="100%"
                                        padding="300"
                                        background={host === p.host ? "bg-surface-selected" : "bg-surface-secondary"}
                                        borderRadius="200"
                                        onClick={() => applyProvider(p)}
                                        style={{
                                            cursor: "pointer",
                                            border: host === p.host ? "1.5px solid var(--p-color-border-emphasis)" : "1.5px solid transparent",
                                            textAlign: "left",
                                        }}
                                    >
                                        <InlineStack align="space-between" blockAlign="center">
                                            <BlockStack gap="050">
                                                <Text as="span" fontWeight="semibold" variant="bodySm">
                                                    {p.name}
                                                </Text>
                                                <Text as="span" tone="subdued" variant="bodySm">
                                                    {p.host} · {p.port}
                                                </Text>
                                            </BlockStack>
                                            <Badge tone={p.enc === "ssl" ? "warning" : "success"}>
                                                {ENC_LABEL[p.enc]}
                                            </Badge>
                                        </InlineStack>
                                    </Box>
                                ))}
                            </BlockStack>
                        </BlockStack>
                    </Card>
                </Layout.Section>
            </Layout>
        </Page>
    );
}
