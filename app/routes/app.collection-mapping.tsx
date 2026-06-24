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
  IndexTable,
  Banner,
  EmptyState,
} from "@shopify/polaris";
import { TitleBar } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { withDbRetry } from "../utils/db-retry.server";
import { getAccountShop } from "../services/store-management.server";
import { useRouteError } from "@remix-run/react";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);

  try {
    const ownerShop = await withDbRetry(() => getAccountShop(session.shop));
    const mappings = await withDbRetry(() =>
      prisma.collectionMapping.findMany({
        where: { sourceStore: { ownerShop } },
        include: {
          sourceStore: { select: { shopDomain: true, shopName: true } },
          destStore: { select: { shopDomain: true, shopName: true } },
        },
        orderBy: { lastSyncedAt: "desc" },
        take: 100,
      })
    );

    return json({
      mappings: mappings.map((m) => ({
        ...m,
        lastSyncedAt: m.lastSyncedAt?.toISOString(),
        createdAt: m.createdAt.toISOString(),
        updatedAt: m.updatedAt.toISOString(),
      })),
      loadError: null as string | null,
    });
  } catch (e) {
    console.error("[CollectionMapping] Loader DB error:", (e as Error).message);
    return json({
      mappings: [],
      loadError:
        "Couldn't load collection mappings right now (temporary connection issue). Please reload.",
    });
  }
};

export const action = async ({ request }: ActionFunctionArgs) => {
  await authenticate.admin(request);
  const formData = await request.formData();
  const intent = formData.get("intent") as string;

  switch (intent) {
    case "update-title": {
      const mappingId = formData.get("mappingId") as string;
      const destTitle = formData.get("destTitle") as string;
      await prisma.collectionMapping.update({
        where: { id: mappingId },
        data: { destTitle: destTitle || null },
      });
      return json({ success: true });
    }

    case "delete": {
      const mappingId = formData.get("mappingId") as string;
      await prisma.collectionMapping.delete({ where: { id: mappingId } });
      return json({ success: true });
    }

    default:
      return json({ error: "Unknown action" }, { status: 400 });
  }
};

export default function CollectionMappingPage() {
  const { mappings, loadError } = useLoaderData<typeof loader>();
  const submit = useSubmit();
  const navigation = useNavigation();
  const isSubmitting = navigation.state === "submitting";

  const [editingId, setEditingId] = useState<string | null>(null);
  const [editTitle, setEditTitle] = useState("");

  const handleSaveTitle = (mappingId: string) => {
    submit(
      { intent: "update-title", mappingId, destTitle: editTitle },
      { method: "POST" }
    );
    setEditingId(null);
  };

  const handleDelete = (mappingId: string) => {
    submit({ intent: "delete", mappingId }, { method: "POST" });
  };

  return (
    <Page>
      <TitleBar title="Collection Mapping" />

      <BlockStack gap="500">
        {loadError && (
          <Banner tone="warning" title="Temporary issue">
            <p>{loadError}</p>
          </Banner>
        )}
        <Banner tone="info">
          <p>
            Collection mappings are automatically created when collections are synced.
            You can override the destination collection title here.
          </p>
        </Banner>

        {mappings.length === 0 ? (
          <Card>
            <EmptyState
              heading="No collection mappings yet"
              image=""
            >
              <p>
                Collection mappings will appear here once collections are synced
                between stores.
              </p>
            </EmptyState>
          </Card>
        ) : (
          <Card padding="0">
            <IndexTable
              headings={[
                { title: "Source Handle" },
                { title: "Source Store" },
                { title: "Dest Store" },
                { title: "Dest Title Override" },
                { title: "Status" },
                { title: "Last Synced" },
                { title: "Actions" },
              ]}
              itemCount={mappings.length}
              selectable={false}
            >
              {mappings.map((mapping: any, index: number) => (
                <IndexTable.Row
                  id={mapping.id}
                  key={mapping.id}
                  position={index}
                >
                  <IndexTable.Cell>
                    <Text as="span" variant="bodyMd" fontWeight="semibold">
                      {mapping.sourceHandle || "—"}
                    </Text>
                  </IndexTable.Cell>
                  <IndexTable.Cell>
                    {mapping.sourceStore.shopName || mapping.sourceStore.shopDomain}
                  </IndexTable.Cell>
                  <IndexTable.Cell>
                    {mapping.destStore.shopName || mapping.destStore.shopDomain}
                  </IndexTable.Cell>
                  <IndexTable.Cell>
                    {editingId === mapping.id ? (
                      <InlineStack gap="200" blockAlign="center">
                        <TextField
                          label=""
                          labelHidden
                          value={editTitle}
                          onChange={setEditTitle}
                          autoComplete="off"
                          size="slim"
                        />
                        <Button size="slim" onClick={() => handleSaveTitle(mapping.id)}>
                          Save
                        </Button>
                        <Button size="slim" onClick={() => setEditingId(null)}>
                          Cancel
                        </Button>
                      </InlineStack>
                    ) : (
                      <InlineStack gap="200" blockAlign="center">
                        <Text as="span">
                          {mapping.destTitle || "Same as source"}
                        </Text>
                        <Button
                          size="slim"
                          onClick={() => {
                            setEditingId(mapping.id);
                            setEditTitle(mapping.destTitle || "");
                          }}
                        >
                          Edit
                        </Button>
                      </InlineStack>
                    )}
                  </IndexTable.Cell>
                  <IndexTable.Cell>
                    <Badge
                      tone={mapping.status === "SYNCED" ? "success" : "attention"}
                    >
                      {mapping.status}
                    </Badge>
                  </IndexTable.Cell>
                  <IndexTable.Cell>
                    {mapping.lastSyncedAt
                      ? new Date(mapping.lastSyncedAt).toLocaleString()
                      : "Never"}
                  </IndexTable.Cell>
                  <IndexTable.Cell>
                    <Button
                      size="slim"
                      tone="critical"
                      onClick={() => handleDelete(mapping.id)}
                      loading={isSubmitting}
                    >
                      Remove
                    </Button>
                  </IndexTable.Cell>
                </IndexTable.Row>
              ))}
            </IndexTable>
          </Card>
        )}
      </BlockStack>
    </Page>
  );
}

export function ErrorBoundary() {
  const error = useRouteError();
  return (
    <Page>
      <TitleBar title="Collection Mapping" />
      <Card>
        <BlockStack gap="300">
          <Text as="h2" variant="headingMd">
            Something went wrong
          </Text>
          <Text as="p" tone="subdued">
            {error instanceof Error ? error.message : "Unexpected error loading collection mappings."}
          </Text>
          <Button url="/app/collection-mapping">Reload page</Button>
        </BlockStack>
      </Card>
    </Page>
  );
}
