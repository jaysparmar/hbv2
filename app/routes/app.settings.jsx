import { Link, Outlet, useMatches, useLoaderData } from "@remix-run/react";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import {
  Page,
  Layout,
  Card,
  BlockStack,
  Text,
  InlineStack,
  Box,
  Icon,
  Divider,
  Badge,
} from "@shopify/polaris";
import { EmailNewsletterIcon, CreditCardIcon, ChevronRightIcon, PersonIcon, FileIcon } from "@shopify/polaris-icons";

export const loader = async ({ request }) => {
  await authenticate.admin(request);
  const [smtpHost, razorpayKey] = await Promise.all([
    prisma.setting.findUnique({ where: { key: "smtp_host" } }),
    prisma.setting.findUnique({ where: { key: "razorpay_key_id" } }),
  ]);
  return {
    smtpConfigured: !!(smtpHost?.value),
    paymentConfigured: !!(razorpayKey?.value),
  };
};

export default function SettingsPage() {
  const { smtpConfigured, paymentConfigured } = useLoaderData();
  const matches = useMatches();
  const isIndex = matches[matches.length - 1].id === "routes/app.settings";

  if (!isIndex) {
    return <Outlet />;
  }

  const settingsLinks = [
    {
      to: "/app/settings/smtp",
      icon: EmailNewsletterIcon,
      title: "SMTP Settings",
      description: "Configure your outgoing email server for notifications and alerts.",
      configured: smtpConfigured,
    },
    {
      to: "/app/settings/payment",
      icon: CreditCardIcon,
      title: "Payment Gateway",
      description: "Configure Razorpay API keys for accepting payments.",
      configured: paymentConfigured,
    },
    {
      to: "/app/settings/staff",
      icon: PersonIcon,
      title: "Staff Management",
      description: "Manage staff members for assigning orders.",
      configured: true,
    },
    {
      to: "/app/settings/print",
      icon: FileIcon,
      title: "Print Settings",
      description: "Configure shipping label and invoice templates.",
      configured: true,
    },
  ];

  return (
    <Page
      title="Settings"
      subtitle="Manage your app configuration and integrations."
    >
      <Layout>
        <Layout.Section>
          <BlockStack gap="200">
            <Text variant="headingSm" as="h2" tone="subdued">Integrations</Text>
            <Card padding="0">
              <BlockStack>
                {settingsLinks.map((item, idx) => (
                  <Box key={item.to}>
                    {idx > 0 && <Divider />}
                    <Link
                      to={item.to}
                      style={{ textDecoration: "none", color: "inherit", display: "block" }}
                    >
                      <Box padding="500" as="div">
                        <InlineStack align="space-between" blockAlign="center">
                          <InlineStack gap="400" blockAlign="center">
                            <Box
                              background="bg-surface-secondary"
                              padding="300"
                              borderRadius="200"
                            >
                              <Icon source={item.icon} tone="base" />
                            </Box>
                            <BlockStack gap="050">
                              <Text variant="bodyMd" fontWeight="semibold" as="span">
                                {item.title}
                              </Text>
                              <Text as="span" tone="subdued" variant="bodySm">
                                {item.description}
                              </Text>
                            </BlockStack>
                          </InlineStack>
                          <InlineStack gap="300" blockAlign="center">
                            <Badge tone={item.configured ? "success" : "attention"}>
                              {item.configured ? "Configured" : "Not set"}
                            </Badge>
                            <Icon source={ChevronRightIcon} tone="subdued" />
                          </InlineStack>
                        </InlineStack>
                      </Box>
                    </Link>
                  </Box>
                ))}
              </BlockStack>
            </Card>
          </BlockStack>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
