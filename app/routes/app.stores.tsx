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
import { useRouteError } from "@remix-run/react";
import { authenticate } from "../shopify.server";
import { withDbRetry } from "../utils/db-retry.server";
import {
  getConnectedStores,
  connectStoreViaOAuth,
  disconnectStore,
  registerBaseStore,
  refreshStoreConnection,
  getAccountShop,
} from "../services/store-management.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);

  try {
    const ownerShop = await withDbRetry(() => getAccountShop(session.shop));
    const stores = await withDbRetry(() => getConnectedStores(ownerShop));
    return json({
      stores,
      currentShop: session.shop,
      appClientId: process.env.SHOPIFY_API_KEY || "",
      loadError: null as string | null,
    });
  } catch (e) {
    console.error("[Stores] Loader DB error:", (e as Error).message);
    return json({
      stores: [],
      currentShop: session.shop,
      appClientId: process.env.SHOPIFY_API_KEY || "",
      loadError:
        "Couldn't load connected stores right now (temporary connection issue). Please reload.",
    });
  }
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const formData = await request.formData();
  const intent = formData.get("intent") as string;

  switch (intent) {
    case "connect-oauth": {
      const shopDomain = formData.get("shopDomain") as string;

      if (!shopDomain) {
        return json({ error: "Shop domain is required" }, { status: 400 });
      }

      const result = await connectStoreViaOAuth(shopDomain, session.shop);

      if (!result.success) {
        return json({ error: result.error }, { status: 400 });
      }

      return json({ success: true, message: "Store connected successfully via OAuth" });
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
  const { stores, currentShop, appClientId, loadError } = useLoaderData<typeof loader>();
  const submit = useSubmit();
  const navigation = useNavigation();
  const isSubmitting = navigation.state === "submitting";

  const [showConnectModal, setShowConnectModal] = useState(false);
  const [shopDomain, setShopDomain] = useState("");
  const [connectStep, setConnectStep] = useState<"install" | "verify">("install");

  const baseStore = stores.find((s: any) => s.isBaseStore);
  const destinationStores = stores.filter((s: any) => !s.isBaseStore);

  const buildInstallUrl = (domain: string) => {
    const d = domain.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/$/, "");
    const storeName = d.replace(".myshopify.com", "");
    return `https://admin.shopify.com/store/${storeName}/oauth/install?client_id=${appClientId}`;
  };

  const handleOpenInstallLink = () => {
    window.open(buildInstallUrl(shopDomain), "_blank");
    setConnectStep("verify");
  };

  const handleReconnect = (domain: string) => {
    // Re-open the install link so the merchant re-authorizes and mints a fresh
    // token, then the store validates on next Refresh.
    window.open(buildInstallUrl(domain), "_blank");
  };

  const handleVerifyConnect = () => {
    submit(
      { intent: "connect-oauth", shopDomain },
      { method: "POST" }
    );
    setShowConnectModal(false);
    setShopDomain("");
    setConnectStep("install");
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
        {loadError && (
          <Banner tone="warning" title="Temporary issue">
            <p>{loadError}</p>
          </Banner>
        )}
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
                        {store.status === "ERROR" && (
                          <Button
                            size="slim"
                            variant="primary"
                            onClick={() => handleReconnect(store.shopDomain)}
                          >
                            Reconnect
                          </Button>
                        )}
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
        onClose={() => {
          setShowConnectModal(false);
          setConnectStep("install");
          setShopDomain("");
        }}
        title="Connect Destination Store"
        primaryAction={
          connectStep === "install"
            ? {
                content: "Open Install Link",
                onAction: handleOpenInstallLink,
                disabled: !shopDomain,
              }
            : {
                content: "Verify & Connect",
                onAction: handleVerifyConnect,
                loading: isSubmitting,
                disabled: !shopDomain,
              }
        }
        secondaryActions={[
          {
            content: "Cancel",
            onAction: () => {
              setShowConnectModal(false);
              setConnectStep("install");
              setShopDomain("");
            },
          },
        ]}
      >
        <Modal.Section>
          <BlockStack gap="400">
            <Banner tone="info">
              <p>
                Link <strong>another Shopify store that you own and operate</strong> as
                a sync destination. This app only copies products between stores
                you control. Connecting takes 2 steps: install this app on that
                store, then verify the connection here.
              </p>
            </Banner>

            <TextField
              label="Your other store's domain"
              value={shopDomain}
              onChange={setShopDomain}
              placeholder="my-other-store.myshopify.com"
              helpText="The .myshopify.com domain of another store you own. This is not the app installation — your current store is already set up as the source."
              autoComplete="off"
            />

            {connectStep === "install" && shopDomain && (
              <Banner tone="warning">
                <p>
                  Step 1: Click "Open Install Link" to install this app on{" "}
                  {shopDomain}. You must be logged into that store's Shopify
                  admin. After installing, come back here and click
                  "Verify &amp; Connect".
                </p>
              </Banner>
            )}

            {connectStep === "verify" && (
              <Banner tone="success">
                <p>
                  Step 2: If you've installed the app on {shopDomain}, click
                  "Verify &amp; Connect" to complete the connection. The app
                  will use the OAuth session to sync products.
                </p>
              </Banner>
            )}
          </BlockStack>
        </Modal.Section>
      </Modal>
    </Page>
  );
}

export function ErrorBoundary() {
  const error = useRouteError();
  return (
    <Page>
      <TitleBar title="Connected Stores" />
      <Card>
        <BlockStack gap="300">
          <Text as="h2" variant="headingMd">
            Something went wrong
          </Text>
          <Text as="p" tone="subdued">
            {error instanceof Error ? error.message : "Unexpected error loading stores."}
          </Text>
          <Button url="/app/stores">Reload page</Button>
        </BlockStack>
      </Card>
    </Page>
  );
}
