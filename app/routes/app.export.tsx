import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { useSubmit, useNavigation } from "@remix-run/react";
import {
  Page,
  Card,
  BlockStack,
  Text,
  InlineStack,
  Button,
  Banner,
} from "@shopify/polaris";
import { TitleBar } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import { exportSyncData, exportSyncLogs } from "../services/data-export.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);
  return json({});
};

export const action = async ({ request }: ActionFunctionArgs) => {
  await authenticate.admin(request);
  const formData = await request.formData();
  const intent = formData.get("intent") as string;

  switch (intent) {
    case "export-config": {
      const data = await exportSyncData();
      return json({ success: true, data, type: "config" });
    }

    case "export-logs": {
      const days = parseInt(formData.get("days") as string) || 7;
      const startDate = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
      const logs = await exportSyncLogs({ startDate, limit: 5000 });
      return json({ success: true, data: logs, type: "logs" });
    }

    default:
      return json({ error: "Unknown action" }, { status: 400 });
  }
};

export default function ExportPage() {
  const submit = useSubmit();
  const navigation = useNavigation();
  const isSubmitting = navigation.state === "submitting";

  const handleExport = (intent: string, extraData?: Record<string, string>) => {
    const data: Record<string, string> = { intent, ...extraData };
    submit(data, { method: "POST" });
  };

  return (
    <Page>
      <TitleBar title="Data Export" />

      <BlockStack gap="500">
        <Banner tone="info">
          <p>
            Export your sync configuration and logs as JSON. Use this for
            backup, migration, or troubleshooting purposes.
          </p>
        </Banner>

        <Card>
          <BlockStack gap="300">
            <Text as="h2" variant="headingMd">
              Export Sync Configuration
            </Text>
            <Text as="p" variant="bodyMd">
              Exports all connected stores, sync rules, price rules, product
              mappings, and collection mappings.
            </Text>
            <Button
              variant="primary"
              onClick={() => handleExport("export-config")}
              loading={isSubmitting}
            >
              Export Configuration
            </Button>
          </BlockStack>
        </Card>

        <Card>
          <BlockStack gap="300">
            <Text as="h2" variant="headingMd">
              Export Sync Logs
            </Text>
            <Text as="p" variant="bodyMd">
              Export recent sync log entries for analysis.
            </Text>
            <InlineStack gap="200">
              <Button
                onClick={() => handleExport("export-logs", { days: "7" })}
                loading={isSubmitting}
              >
                Last 7 Days
              </Button>
              <Button
                onClick={() => handleExport("export-logs", { days: "30" })}
                loading={isSubmitting}
              >
                Last 30 Days
              </Button>
              <Button
                onClick={() => handleExport("export-logs", { days: "90" })}
                loading={isSubmitting}
              >
                Last 90 Days
              </Button>
            </InlineStack>
          </BlockStack>
        </Card>
      </BlockStack>
    </Page>
  );
}
