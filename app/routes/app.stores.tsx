import { useState } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { useLoaderData, useSubmit, useNavigation } from "@remix-run/react";
import {
  Page,
  Layout,
  Card,
  BlockStack,
  Text,
  InlineStack,
  Badge,
  Button,
  TextField,
  Modal,
  Banner,
  Box,
  InlineGrid,
  Divider,
} from "@shopify/polaris";
import { TitleBar } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import {
  getConnectedStores,
  connectStoreWithToken,
  disconnectStore,
  registerBaseStore,
  refreshStoreConnection,
} from "../services/store-management.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const stores = await getConnectedStores();

  return json({
    stores,
    currentShop: session.shop,
  });
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const formData = await request.formData();
  const intent = formData.get("intent") as string;

  switch (intent) {
    case "connect-token": {
      const shopDomain = formData.get("shopDomain") as string;
      const accessToken = formData.get("accessToken") as string;

      if (!shopDomain || !accessToken) {
        return json({ error: "Shop domain and access token are required" }, { status: 400 });
      }

      const result = await connectStoreWithToken(
        shopDomain,
        accessToken,
        session.shop
      );

      if (!result.success) {
        return json({ error: result.error }, { status: 400 });
      }

      return json({ success: true, message: "Store connected successfully" });
    }

    case "register-base": {
      await registerBaseStore(
        session.shop,
        session.accessToken || "",
        undefined
      );
      return json({ success: true, message: "Base store registered" });
    }

    case "disconnect": {
      const storeId = formData.get("storeId") as string;
      try {
        await disconnectStore(storeId);
        return json({ success: true, message: "Store disconnected" });
      } catch (error) {
        return json({ error: (error as Error).message }, { status: 400 });
      }
    }

    case "refresh": {
      const storeId = formData.get("storeId") as string;
      const result = await refreshStoreConnection(storeId);
      if (!result.success) {
        return json({ error: result.error }, { status: 400 });
      }
      return json({ success: true, message: "Connection refreshed" });
    }

    default:
      return json({ error: "Unknown action" }, { status: 400 });
  }
};

export default function StoresPage() {
  const { stores, currentShop } = useLoaderData<typeof loader>();
  const submit = useSubmit();
  const navigation = useNavigation();
  const isSubmitting = navigation.state === "submitting";

  const [showConnectModal, setShowConnectModal] = useState(false);
  const [shopDomain, setShopDomain] = useState("");
  const [accessToken, setAccessToken] = useState("");

  const baseStore = stores.find((s: any) => s.isBaseStore);
  const destinationStores = stores.filter((s: any) => !s.isBaseStore);

  const handleConnect = () => {
    submit(
      { intent: "connect-token", shopDomain, accessToken },
      { method: "POST" }
    );
    setShowConnectModal(false);
    setShopDomain("");
    setAccessToken("");
  };

  const handleRegisterBase = () => {
    submit({ intent: "register-base" }, { method: "POST" });
  };

  const handleDisconnect = (storeId: string) => {
    submit({ intent: "disconnect", storeId }, { method: "POST" });
  };

  const handleRefresh = (storeId: string) => {
    submit({ intent: "refresh", storeId }, { method: "POST" });
  };

  return (
    <Page>
      <TitleBar title="Connected Stores">
        <button variant="primary" onClick={() => setShowConnectModal(true)}>
          Connect Destination Store
        </button>
      </TitleBar>

      <BlockStack gap="500">
        {/* Base Store Section */}
        <Card>
          <BlockStack gap="400">
            <InlineStack align="space-between" blockAlign="center">
              <Text as="h2" variant="headingMd">
                Base Store (Source)
              </Text>
              <Badge tone="info">Source of truth</Badge>
            </InlineStack>

            {baseStore ? (
              <Box padding="300" background="bg-surface-secondary" borderRadius="200">
                <InlineStack align="space-between" blockAlign="center">
                  <BlockStack gap="100">
                    <Text as="p" variant="bodyMd" fontWeight="semibold">
                      {baseStore.shopName || baseStore.shopDomain}
                    </Text>
                    <Text as="p" variant="bodySm" tone="subdued">
                      {baseStore.shopDomain} | {baseStore.currencyCode}
                    </Text>
                  </BlockStack>
                  <InlineStack gap="200">
                    <Badge
                      tone={baseStore.status === "ACTIVE" ? "success" : "critical"}
                    >
                      {baseStore.status}
                    </Badge>
                    <Button
                      size="slim"
                      onClick={() => handleRefresh(baseStore.id)}
                      loading={isSubmitting}
                    >
                      Refresh
                    </Button>
                  </InlineStack>
                </InlineStack>
              </Box>
            ) : (
              <Banner
                title="No base store registered"
                tone="warning"
                action={{ content: "Register this store as base", onAction: handleRegisterBase }}
              >
                <p>
                  Register {currentShop} as the base store to start syncing
                  products to destination stores.
                </p>
              </Banner>
            )}
          </BlockStack>
        </Card>

        {/* Destination Stores */}
        <Card>
          <BlockStack gap="400">
            <InlineStack align="space-between" blockAlign="center">
              <Text as="h2" variant="headingMd">
                Destination Stores ({destinationStores.length})
              </Text>
              <Button onClick={() => setShowConnectModal(true)}>
                Add Store
              </Button>
            </InlineStack>

            {destinationStores.length === 0 ? (
              <Text as="p" variant="bodyMd" tone="subdued">
                No destination stores connected yet. Add a store to start
                syncing products.
              </Text>
            ) : (
              <BlockStack gap="300">
                {destinationStores.map((store: any) => (
                  <Box
                    key={store.id}
                    padding="300"
                    background="bg-surface-secondary"
                    borderRadius="200"
                  >
                    <InlineStack align="space-between" blockAlign="center">
                      <BlockStack gap="100">
                        <Text as="p" variant="bodyMd" fontWeight="semibold">
                          {store.shopName || store.shopDomain}
                        </Text>
                        <InlineStack gap="200">
                          <Text as="span" variant="bodySm" tone="subdued">
                            {store.shopDomain}
                          </Text>
                          <Text as="span" variant="bodySm" tone="subdued">
                            | {store.currencyCode}
                          </Text>
                          <Text as="span" variant="bodySm" tone="subdued">
                            | {store.authMethod === "OAUTH" ? "OAuth" : "Token"}
                          </Text>
                        </InlineStack>
                        {store.lastSyncAt && (
                          <Text as="p" variant="bodySm" tone="subdued">
                            Last sync:{" "}
                            {new Date(store.lastSyncAt).toLocaleString()}
                          </Text>
                        )}
                      </BlockStack>
                      <InlineStack gap="200">
                        <Badge
                          tone={
                            store.status === "ACTIVE"
                              ? "success"
                              : store.status === "ERROR"
                              ? "critical"
                              : "attention"
                          }
                        >
                          {store.status}
                        </Badge>
                        <Button
                          size="slim"
                          onClick={() => handleRefresh(store.id)}
                          loading={isSubmitting}
                        >
                          Refresh
                        </Button>
                        <Button
                          size="slim"
                          tone="critical"
                          onClick={() => handleDisconnect(store.id)}
                          loading={isSubmitting}
                        >
                          Disconnect
                        </Button>
                      </InlineStack>
                    </InlineStack>
                  </Box>
                ))}
              </BlockStack>
            )}
          </BlockStack>
        </Card>
      </BlockStack>

      {/* Connect Store Modal */}
      <Modal
        open={showConnectModal}
        onClose={() => setShowConnectModal(false)}
        title="Connect Destination Store"
        primaryAction={{
          content: "Connect",
          onAction: handleConnect,
          loading: isSubmitting,
          disabled: !shopDomain || !accessToken,
        }}
        secondaryActions={[
          {
            content: "Cancel",
            onAction: () => setShowConnectModal(false),
          },
        ]}
      >
        <Modal.Section>
          <BlockStack gap="400">
            <Banner tone="info">
              <p>
                To connect a destination store, create a Custom App in that
                store's admin (Settings &gt; Apps and sales channels &gt;
                Develop apps) and paste the Admin API access token here.
              </p>
            </Banner>

            <TextField
              label="Store domain"
              value={shopDomain}
              onChange={setShopDomain}
              placeholder="my-store.myshopify.com"
              helpText="The myshopify.com domain of the destination store"
              autoComplete="off"
            />

            <TextField
              label="Admin API access token"
              value={accessToken}
              onChange={setAccessToken}
              placeholder="shpat_..."
              type="password"
              helpText="From the Custom App's API credentials page"
              autoComplete="off"
            />
          </BlockStack>
        </Modal.Section>
      </Modal>
    </Page>
  );
}
