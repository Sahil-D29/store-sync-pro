import { useEffect, useRef, useState } from "react";
import { useFetcher, useNavigate } from "@remix-run/react";
import {
  Badge,
  Banner,
  BlockStack,
  Box,
  Button,
  Card,
  Checkbox,
  ChoiceList,
  Divider,
  InlineGrid,
  InlineStack,
  Modal,
  Pagination,
  ProgressBar,
  Select,
  Spinner,
  Text,
  TextField,
} from "@shopify/polaris";
import {
  DEFAULT_SELECTION,
  PRODUCT_STATUSES,
} from "../services/catalog-selection";
import type { CatalogSelection } from "../services/catalog-selection";
import type {
  CatalogCounts,
  CatalogResult,
} from "../services/catalog-reconciliation.server";

type Rule = {
  id: string;
  name: string;
  sourceStore: { shopDomain: string; shopName: string | null };
  destStore: { shopDomain: string; shopName: string | null };
};
export type CatalogStore = Rule["sourceStore"] & {
  id: string;
  isBaseStore: boolean;
};
type CatalogData = {
  error?: string;
  ruleId: string;
  snapshotId?: string | null;
  job?: {
    id: string;
    operation: string;
    status: string;
    processed: number;
    total: number;
    error: string | null;
    result: CatalogResult | null;
  } | null;
  snapshot?: {
    sourceCounts: CatalogCounts | null;
    destCounts: CatalogCounts | null;
    sourceError: string | null;
    destError: string | null;
    refreshedAt: string;
    eligible: number;
    synced: number;
    matched: number;
    unmatched: number;
    failed: number;
    missing?: number;
  } | null;
  collections?: Array<{ id: string; title: string }>;
  tags?: string[];
  priceRules?: Array<{ id: string; name: string }>;
};
type Preview = {
  error?: string;
  ruleId?: string;
  snapshotId?: string;
  requestKey?: string;
  selectedCount?: number;
  count?: number;
  page?: number;
  pageCount?: number;
  products?: Array<{
    id: string;
    title: string;
    handle: string;
    status: string;
    state: string;
  }>;
};
const label = (value: string) => value.charAt(0) + value.slice(1).toLowerCase();
const storeName = (store: Rule["sourceStore"]) =>
  store.shopName || store.shopDomain;

function StoreCard({
  title,
  store,
  counts,
  error,
  refreshedAt,
  loading = false,
  onRefresh,
}: {
  title: string;
  store: Rule["sourceStore"];
  counts?: CatalogCounts | null;
  error?: string | null;
  refreshedAt?: string;
  loading?: boolean;
  onRefresh?: () => void;
}) {
  return (
    <Card>
      <BlockStack gap="300">
        <InlineStack align="space-between">
          <Badge tone="info">{title}</Badge>
          <Text as="span" tone="subdued">
            {counts ? "Exact count" : "Awaiting catalog"}
          </Text>
        </InlineStack>
        {onRefresh && (
          <InlineStack gap="200" blockAlign="center">
            <Button onClick={onRefresh} loading={loading} disabled={loading}>
              Refresh counts
            </Button>
            {loading && (
              <Text as="span" tone="subdued">
                Loading product counts…
              </Text>
            )}
          </InlineStack>
        )}
        <BlockStack gap="100">
          <Text as="h3" variant="headingMd">
            {storeName(store)}
          </Text>
          <Text as="p" tone="subdued" breakWord>
            {store.shopDomain}
          </Text>
        </BlockStack>
        <Text as="p" variant="heading2xl">
          {counts ? counts.total.toLocaleString() : "—"}
        </Text>
        <Text as="p" tone="subdued">
          Total products
        </Text>
        <Divider />
        <InlineGrid columns={{ xs: 2, sm: 4 }} gap="300">
          {PRODUCT_STATUSES.map((status) => (
            <BlockStack gap="100" key={status}>
              <Text as="p" tone="subdued">
                {label(status)}
              </Text>
              <Text as="p" variant="headingMd">
                {counts ? counts[status].toLocaleString() : "—"}
              </Text>
            </BlockStack>
          ))}
        </InlineGrid>
        {error && (
          <Banner tone="warning">
            <p>{error}</p>
          </Banner>
        )}
        {refreshedAt && (
          <Text as="p" variant="bodySm" tone="subdued">
            Refreshed {new Date(refreshedAt).toLocaleString()}
          </Text>
        )}
      </BlockStack>
    </Card>
  );
}
function ConnectedStoreCountCard({
  store,
  refreshKey,
  title,
}: {
  store: CatalogStore;
  refreshKey: number;
  title?: string;
}) {
  const fetcher = useFetcher<{
    storeId: string;
    counts?: CatalogCounts;
    refreshedAt?: string;
    error?: string;
  }>();
  const refresh = () =>
    fetcher.load(`/api/store-counts/${encodeURIComponent(store.id)}`);
  useEffect(() => {
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [store.id, refreshKey]);
  const data = fetcher.data?.storeId === store.id ? fetcher.data : undefined;
  return (
    <StoreCard
      title={title || (store.isBaseStore ? "Source" : "Destination")}
      store={store}
      counts={data?.counts}
      error={data?.error}
      refreshedAt={data?.refreshedAt}
      loading={fetcher.state !== "idle"}
      onRefresh={refresh}
    />
  );
}
export function ConnectedCatalogOverview({
  stores,
  onPrepared,
}: {
  stores: CatalogStore[];
  onPrepared?: (rule: Rule, jobId: string) => void;
}) {
  const [refreshKey, setRefreshKey] = useState(0);
  const [sourceId, setSourceId] = useState(
    stores.find((s) => s.isBaseStore)?.id || stores[0]?.id || "",
  );
  const [destId, setDestId] = useState(
    stores.find((s) => s.id !== sourceId)?.id || "",
  );
  const preparation = useFetcher<{
    rule?: Rule;
    jobId?: string;
    error?: string;
  }>();
  const handled = useRef<string | null>(null);
  useEffect(() => {
    if (
      preparation.state === "idle" &&
      preparation.data?.rule &&
      preparation.data.jobId &&
      handled.current !== preparation.data.jobId
    ) {
      handled.current = preparation.data.jobId;
      onPrepared?.(preparation.data.rule, preparation.data.jobId);
    }
  }, [preparation.state, preparation.data, onPrepared]);
  return (
    <BlockStack gap="400">
      <InlineStack align="space-between" gap="300" blockAlign="center">
        <BlockStack gap="100">
          <Text as="h2" variant="headingLg">
            Your product overview
          </Text>
          <Text as="p" tone="subdued">
            Product totals for your connected stores, independent of sync rules.
          </Text>
        </BlockStack>
        {stores.length > 0 && (
          <Button onClick={() => setRefreshKey((value) => value + 1)}>
            Refresh all counts
          </Button>
        )}
      </InlineStack>
      {stores.length > 0 && (
        <InlineGrid columns={{ xs: 1, md: 2 }} gap="400">
          {stores.map((store) => (
            <ConnectedStoreCountCard
              key={store.id}
              store={store}
              refreshKey={refreshKey}
            />
          ))}
        </InlineGrid>
      )}
      <Card>
        <BlockStack gap="300">
          {stores.length >= 2 && (
            <>
              <Text as="h3" variant="headingMd">
                Add products missing from your destination
              </Text>
              <Text as="p" tone="subdued">
                Find source products that have no destination match by handle,
                then choose statuses, collections, tags, or individual products
                to copy. Existing destination products stay unchanged.
              </Text>
              <InlineGrid columns={{ xs: 1, sm: 2 }} gap="300">
                <Select
                  label="Source store"
                  value={sourceId}
                  options={stores.map((s) => ({
                    label: storeName(s),
                    value: s.id,
                  }))}
                  onChange={(value) => {
                    setSourceId(value);
                    if (value === destId)
                      setDestId(stores.find((s) => s.id !== value)?.id || "");
                  }}
                />
                <Select
                  label="Destination store"
                  value={destId}
                  options={stores
                    .filter((s) => s.id !== sourceId)
                    .map((s) => ({ label: storeName(s), value: s.id }))}
                  onChange={setDestId}
                />
              </InlineGrid>
              <InlineStack>
                <Button
                  variant="primary"
                  loading={preparation.state !== "idle"}
                  disabled={
                    !sourceId ||
                    !destId ||
                    sourceId === destId ||
                    preparation.state !== "idle"
                  }
                  onClick={() =>
                    preparation.submit(
                      {
                        intent: "PREPARE_MISSING",
                        sourceStoreId: sourceId,
                        destStoreId: destId,
                      },
                      {
                        method: "POST",
                        action: "/api/catalog",
                        encType: "application/json",
                      },
                    )
                  }
                >
                  Add missing products
                </Button>
              </InlineStack>
              <Text as="p" variant="bodySm" tone="subdued">
                Manual copy only. This does not enable automatic syncing. Source
                prices and product statuses are preserved; plan limits apply.
              </Text>
              {preparation.data?.error && (
                <Banner tone="warning">
                  <p>{preparation.data.error}</p>
                </Banner>
              )}
              <Divider />
            </>
          )}
          <Text as="p" tone="subdued">
            {stores.length
              ? "For ongoing product updates, configure a sync rule."
              : "Connect your source and destination stores to see product totals and status breakdowns."}
          </Text>
          <InlineStack gap="200">
            <Button
              variant="primary"
              url={stores.length ? "/app/sync-rules" : "/app/stores"}
            >
              {stores.length ? "Create sync rule" : "Connect stores"}
            </Button>
            {stores.length > 0 && (
              <Button url="/app/stores">Manage stores</Button>
            )}
          </InlineStack>
        </BlockStack>
      </Card>
    </BlockStack>
  );
}
export function CatalogOverview({
  rules: savedRules,
  stores = [],
}: {
  rules: Rule[];
  stores?: CatalogStore[];
}) {
  const navigate = useNavigate();
  const [preparedRules, setPreparedRules] = useState<Rule[]>([]);
  const rules = [
    ...savedRules,
    ...preparedRules.filter(
      (r) => !savedRules.some((saved) => saved.id === r.id),
    ),
  ];
  const [pendingMissingJob, setPendingMissingJob] = useState<string | null>(
    null,
  );
  const [storeRefreshKey, setStoreRefreshKey] = useState(0);
  const [ruleId, setRuleId] = useState(rules[0]?.id || "");
  const [open, setOpen] = useState(false);
  const [selection, setSelection] = useState<CatalogSelection>({
    ...DEFAULT_SELECTION,
  });
  const [search, setSearch] = useState("");
  const [optionSearch, setOptionSearch] = useState("");
  const [page, setPage] = useState(1);
  const [browse, setBrowse] = useState(false);
  const state = useFetcher<CatalogData>();
  const operation = useFetcher<{
    error?: string;
    jobId?: string;
    ruleId?: string;
    rule?: Rule;
  }>();
  const preview = useFetcher<Preview>();
  const initialized = useRef(new Set<string>());
  const submitted = useRef<string | null>(null);
  const refreshedFinishedJob = useRef<string | null>(null);
  const data = state.data?.ruleId === ruleId ? state.data : undefined;
  const job = data?.job;
  const snapshot = data?.snapshot;
  const rule = rules.find((r) => r.id === ruleId);
  const sourceStore = stores.find(
    (store) => store.shopDomain === rule?.sourceStore.shopDomain,
  );
  const destinationStore = stores.find(
    (store) => store.shopDomain === rule?.destStore.shopDomain,
  );
  const running = job?.status === "RUNNING" || operation.state !== "idle";
  const available = !!snapshot && !snapshot.sourceError && !snapshot.destError;
  const requestKey = JSON.stringify({
    ruleId,
    selection,
    search,
    page,
    browse,
    snapshotId: data?.snapshotId,
  });
  const currentPreview =
    preview.data?.requestKey === requestKey ? preview.data : undefined;
  const previewReady =
    !!currentPreview && !currentPreview.error && preview.state === "idle";
  const operationError =
    operation.data?.ruleId === ruleId ? operation.data.error : undefined;
  const reload = () =>
    state.load(`/api/catalog?ruleId=${encodeURIComponent(ruleId)}`);
  const start = (intent: string) => {
    operation.submit(
      {
        intent,
        ruleId,
        selection,
        snapshotId: currentPreview?.snapshotId || data?.snapshotId || null,
      },
      { method: "POST", action: "/api/catalog", encType: "application/json" },
    );
  };
  useEffect(() => {
    if (ruleId) state.load(`/api/catalog?ruleId=${encodeURIComponent(ruleId)}`);
    // Fetchers are stable Remix handles; rule changes are the trigger.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ruleId]);
  useEffect(() => {
    if (
      operation.state === "idle" &&
      operation.data?.rule &&
      operation.data.jobId &&
      submitted.current !== operation.data.jobId
    ) {
      const prepared = operation.data.rule;
      submitted.current = operation.data.jobId;
      setPreparedRules((current) => [
        ...current.filter((r) => r.id !== prepared.id),
        prepared,
      ]);
      setRuleId(prepared.id);
      setSelection({ ...DEFAULT_SELECTION, missingOnly: true });
      setPendingMissingJob(operation.data.jobId);
      state.load(`/api/catalog?ruleId=${encodeURIComponent(prepared.id)}`);
      return;
    }
    if (
      operation.state === "idle" &&
      operation.data?.jobId &&
      operation.data.ruleId === ruleId &&
      submitted.current !== operation.data.jobId
    ) {
      submitted.current = operation.data.jobId;
      reload();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [operation.state, operation.data, ruleId]);
  useEffect(() => {
    if (
      !ruleId ||
      !data ||
      data.error ||
      snapshot ||
      job ||
      initialized.current.has(ruleId)
    )
      return;
    initialized.current.add(ruleId);
    start("COMPARE");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, ruleId]);
  useEffect(() => {
    if (job?.status !== "RUNNING") return;
    const timer = setInterval(reload, 3000);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [job?.status, ruleId]);
  useEffect(() => {
    if (
      job?.operation === "SYNC" &&
      job.status !== "RUNNING" &&
      submitted.current === job.id &&
      refreshedFinishedJob.current !== job.id
    ) {
      refreshedFinishedJob.current = job.id;
      setStoreRefreshKey((value) => value + 1);
    }
  }, [job?.id, job?.status, job?.operation]);
  useEffect(() => {
    if (
      !pendingMissingJob ||
      job?.id !== pendingMissingJob ||
      job.status === "RUNNING"
    )
      return;
    if (available && data?.snapshotId === pendingMissingJob) setOpen(true);
    setPendingMissingJob(null);
  }, [pendingMissingJob, job, available, data?.snapshotId]);
  useEffect(() => {
    if (!open || !available) return;
    const timer = setTimeout(
      () =>
        preview.submit(
          {
            intent: "preview",
            ruleId,
            selection,
            search,
            page,
            browse,
            requestKey,
          },
          {
            method: "POST",
            action: "/api/catalog",
            encType: "application/json",
          },
        ),
      250,
    );
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, available, requestKey]);
  const changeSelection = (patch: Partial<CatalogSelection>) => {
    setSelection((current) => ({ ...current, ...patch }));
    setPage(1);
  };
  const close = () => setOpen(false);

  if (!rules.length || !rule)
    return (
      <ConnectedCatalogOverview
        stores={stores}
        onPrepared={(prepared, jobId) => {
          setPreparedRules((current) => [
            ...current.filter((r) => r.id !== prepared.id),
            prepared,
          ]);
          setRuleId(prepared.id);
          setSelection({ ...DEFAULT_SELECTION, missingOnly: true });
          setPendingMissingJob(jobId);
        }}
      />
    );
  return (
    <BlockStack gap="400">
      <InlineStack align="space-between" blockAlign="center" gap="300">
        <BlockStack gap="100">
          <Text as="h2" variant="headingLg">
            Your product overview
          </Text>
          <Text as="p" tone="subdued">
            Compare catalogs and bring the right products across.
          </Text>
        </BlockStack>
        <Button
          onClick={() => {
            setStoreRefreshKey((value) => value + 1);
            start("COMPARE");
          }}
          disabled={running}
          loading={running && job?.operation === "COMPARE"}
        >
          Refresh catalogs
        </Button>
      </InlineStack>
      <Card>
        <Select
          label="Source → destination sync rule"
          options={rules.map((r) => ({
            label: `${r.name} · ${storeName(r.sourceStore)} → ${storeName(r.destStore)}`,
            value: r.id,
          }))}
          value={ruleId}
          onChange={(value) => {
            setRuleId(value);
            setOpen(false);
            setSelection({ ...DEFAULT_SELECTION });
            setSearch("");
            setOptionSearch("");
            setPage(1);
            setBrowse(false);
          }}
        />
      </Card>
      {(data?.error || operationError) && (
        <Banner tone="critical">
          <p>{data?.error || operationError}</p>
        </Banner>
      )}
      <InlineGrid columns={{ xs: 1, md: 2 }} gap="400">
        {sourceStore ? (
          <ConnectedStoreCountCard
            key={sourceStore.id}
            store={sourceStore}
            title="Source"
            refreshKey={storeRefreshKey}
          />
        ) : (
          <StoreCard
            title="Source"
            store={rule.sourceStore}
            counts={snapshot?.sourceCounts}
            error={snapshot?.sourceError}
            refreshedAt={snapshot?.refreshedAt}
          />
        )}
        {destinationStore ? (
          <ConnectedStoreCountCard
            key={destinationStore.id}
            store={destinationStore}
            title="Destination"
            refreshKey={storeRefreshKey}
          />
        ) : (
          <StoreCard
            title="Destination"
            store={rule.destStore}
            counts={snapshot?.destCounts}
            error={snapshot?.destError}
            refreshedAt={snapshot?.refreshedAt}
          />
        )}
      </InlineGrid>
      <Card>
        <BlockStack gap="400">
          <BlockStack gap="100">
            <Text as="h3" variant="headingMd">
              Close the catalog gap
            </Text>
            <Text as="p" tone="subdued">
              These counts follow the selected sync rule. Store totals above
              include the whole catalog.
            </Text>
          </BlockStack>
          <InlineGrid columns={{ xs: 2, sm: 3 }} gap="300">
            {[
              ["Rule eligible", snapshot?.eligible],
              ["Successfully synced", snapshot?.synced],
              ["Matched, awaiting sync", snapshot?.matched],
              ["Unmatched", snapshot?.unmatched],
              ["Failed, ready to retry", snapshot?.failed],
              ["Missing in destination", snapshot?.missing],
            ].map(([title, count]) => (
              <BlockStack gap="100" key={title}>
                <Text as="p" tone="subdued">
                  {title}
                </Text>
                <Text as="p" variant="headingLg">
                  {available && typeof count === "number"
                    ? count.toLocaleString()
                    : "—"}
                </Text>
              </BlockStack>
            ))}
          </InlineGrid>
          <InlineStack gap="300">
            <Button
              variant="primary"
              disabled={running || !sourceStore || !destinationStore}
              onClick={() => {
                if (available) {
                  setSelection({
                    ...DEFAULT_SELECTION,
                    missingOnly: true,
                    priceRuleId: null,
                  });
                  setSearch("");
                  setOptionSearch("");
                  setPage(1);
                  setBrowse(false);
                  setOpen(true);
                  return;
                }
                operation.submit(
                  {
                    intent: "PREPARE_MISSING",
                    sourceStoreId: sourceStore!.id,
                    destStoreId: destinationStore!.id,
                  },
                  {
                    method: "POST",
                    action: "/api/catalog",
                    encType: "application/json",
                  },
                );
              }}
            >
              {available
                ? `Add missing (${snapshot?.missing ?? 0})`
                : "Add missing products"}
            </Button>
            <Button
              onClick={() => {
                setSelection({
                  ...DEFAULT_SELECTION,
                  existingOnly: true,
                  priceRuleId: null,
                });
                setSearch("");
                setOptionSearch("");
                setPage(1);
                setBrowse(false);
                setOpen(true);
              }}
              disabled={
                !available ||
                running ||
                snapshot?.eligible === snapshot?.missing
              }
            >
              Update existing products
            </Button>
            <Button
              onClick={() => start("MATCH")}
              disabled={!available || running}
            >
              Match existing products
            </Button>
          </InlineStack>
          <Text as="p" variant="bodySm" tone="subdued">
            Add copies only products missing from the destination. Update
            changes only products already there. Match links existing products
            without changing them.
          </Text>
          {running && (
            <BlockStack gap="200">
              <InlineStack gap="200">
                <Spinner size="small" />
                <Text as="p">
                  {job?.operation === "MATCH"
                    ? "Matching existing products"
                    : job?.operation === "SYNC"
                      ? job.result?.phase === "REFRESHING_COUNTS"
                        ? "Product work finished · refreshing counts"
                        : "Processing selected products"
                      : "Comparing catalogs"}
                  {job?.total
                    ? ` · ${job.processed} of ${job.total}`
                    : " · reading catalogs"}
                </Text>
              </InlineStack>
              {!!job?.total && (
                <ProgressBar
                  progress={Math.round((job.processed / job.total) * 100)}
                />
              )}
            </BlockStack>
          )}
          {job && job.status !== "RUNNING" && (
            <Banner
              tone={
                job.status === "FAILED" ||
                job.status === "COMPLETED_WITH_ERRORS"
                  ? "warning"
                  : "success"
              }
              title={
                job.operation === "COMPARE"
                  ? "Catalog comparison finished"
                  : job.operation === "MATCH"
                    ? "Matching finished"
                    : "Selective sync finished"
              }
            >
              <p>
                {job.error ||
                  (job.result
                    ? `${job.result.matched} matched · ${job.result.synced} synced · ${job.result.skipped} skipped · ${job.result.failed} failed`
                    : job.status)}
              </p>
              {job.result?.conflicts.map((message, i) => (
                <p key={i}>{message}</p>
              ))}
            </Banner>
          )}
        </BlockStack>
      </Card>
      <Modal
        open={open}
        onClose={close}
        title={
          selection.missingOnly
            ? "Add products missing from destination"
            : "Update existing destination products"
        }
        size="large"
        primaryAction={{
          content: `${selection.missingOnly ? "Add" : "Update"} ${currentPreview?.selectedCount ?? 0} selected products`,
          onAction: () => {
            start("SYNC");
            close();
          },
          disabled: !previewReady || !currentPreview?.selectedCount || running,
        }}
        secondaryActions={[{ content: "Cancel", onAction: close }]}
      >
        <Modal.Section>
          <BlockStack gap="400">
            <Banner tone="info">
              <p>
                {selection.missingOnly
                  ? "Only products missing from the destination will be copied. Existing products will not be updated. "
                  : "Only products already present in the destination can be updated. Missing products will not be created. "}
                Status, collection, tag, and manual filters narrow this list.
                These settings apply only to this operation.
              </p>
            </Banner>
            <BlockStack gap="200">
              <Select
                label="Price rule for this operation"
                value={selection.priceRuleId || ""}
                options={[
                  { label: "Copy source prices unchanged", value: "" },
                  ...(data?.priceRules || []).map((price) => ({
                    label: price.name,
                    value: price.id,
                  })),
                ]}
                onChange={(priceRuleId) =>
                  changeSelection({ priceRuleId: priceRuleId || null })
                }
                helpText="Applies only to the selected products in this operation. Your saved sync-rule settings will not change."
              />
              <InlineStack gap="200">
                <Button
                  onClick={() => {
                    close();
                    navigate("/app/price-rules");
                  }}
                >
                  Create price rule
                </Button>
                <Button onClick={reload} loading={state.state !== "idle"}>
                  Refresh price rules
                </Button>
              </InlineStack>
            </BlockStack>
            <ChoiceList
              title="Product status"
              allowMultiple
              choices={PRODUCT_STATUSES.map((status) => ({
                label: label(status),
                value: status,
              }))}
              selected={selection.statuses}
              onChange={(statuses) =>
                changeSelection({
                  statuses: statuses as CatalogSelection["statuses"],
                })
              }
            />
            <Select
              label="Narrow your selection"
              value={selection.method}
              options={[
                {
                  label: selection.missingOnly
                    ? "All missing products"
                    : "All existing products",
                  value: "ALL",
                },
                { label: "Selected source collections", value: "COLLECTIONS" },
                { label: "Source product tags", value: "TAGS" },
                { label: "Manually select products", value: "MANUAL" },
              ]}
              onChange={(method) => {
                changeSelection({
                  method: method as CatalogSelection["method"],
                });
                setBrowse(method === "MANUAL");
                setSearch("");
                setOptionSearch("");
              }}
            />
            {(selection.method === "COLLECTIONS" ||
              selection.method === "TAGS") && (
              <BlockStack gap="200">
                <TextField
                  label={
                    selection.method === "COLLECTIONS"
                      ? "Find source collections"
                      : "Find source tags"
                  }
                  value={optionSearch}
                  onChange={setOptionSearch}
                  autoComplete="off"
                />
                {selection.method === "COLLECTIONS" ? (
                  <ChoiceList
                    title="Source collections (match any selected collection)"
                    allowMultiple
                    choices={(data?.collections || [])
                      .filter(
                        (c) =>
                          c.title
                            .toLowerCase()
                            .includes(optionSearch.toLowerCase()) ||
                          selection.collectionIds.includes(c.id),
                      )
                      .map((c) => ({ label: c.title, value: c.id }))}
                    selected={selection.collectionIds}
                    onChange={(collectionIds) =>
                      changeSelection({ collectionIds })
                    }
                  />
                ) : (
                  <>
                    <ChoiceList
                      title="Source tags"
                      allowMultiple
                      choices={(data?.tags || [])
                        .filter(
                          (tag) =>
                            tag
                              .toLowerCase()
                              .includes(optionSearch.toLowerCase()) ||
                            selection.tags.includes(tag),
                        )
                        .map((tag) => ({ label: tag, value: tag }))}
                      selected={selection.tags}
                      onChange={(tags) => changeSelection({ tags })}
                    />
                    <Select
                      label="Tag matching"
                      options={[
                        { label: "Any selected tag", value: "ANY" },
                        { label: "All selected tags", value: "ALL" },
                      ]}
                      value={selection.tagMode}
                      onChange={(tagMode) =>
                        changeSelection({ tagMode: tagMode as "ANY" | "ALL" })
                      }
                    />
                  </>
                )}
                <Text as="p" tone="subdued">
                  Select at least one{" "}
                  {selection.method === "COLLECTIONS" ? "collection" : "tag"}.
                </Text>
              </BlockStack>
            )}
            <Divider />
            <InlineStack align="space-between">
              <Text as="h3" variant="headingMd">
                {previewReady
                  ? `${currentPreview.selectedCount} products selected`
                  : "Updating selection…"}
              </Text>
              {selection.method === "MANUAL" && (
                <Button
                  onClick={() => {
                    setBrowse(!browse);
                    setPage(1);
                    setSearch("");
                  }}
                >
                  {browse
                    ? "Preview selected"
                    : selection.missingOnly
                      ? "Browse missing"
                      : "Browse existing"}
                </Button>
              )}
            </InlineStack>
            <TextField
              label="Search products by title or handle"
              value={search}
              onChange={(value) => {
                setSearch(value);
                setPage(1);
              }}
              autoComplete="off"
              helpText="Search changes the displayed list, not your selection."
            />
            {currentPreview?.error && (
              <Banner tone="warning">
                <p>{currentPreview.error}</p>
              </Banner>
            )}
            {currentPreview?.error ? null : !previewReady ? (
              <Spinner size="small" />
            ) : (
              <BlockStack gap="200">
                {currentPreview.products?.length ? (
                  currentPreview.products.map((product) => (
                    <Box
                      key={product.id}
                      padding="300"
                      background="bg-surface-secondary"
                      borderRadius="200"
                    >
                      <InlineStack
                        align="space-between"
                        blockAlign="center"
                        gap="200"
                      >
                        <BlockStack gap="100">
                          {selection.method === "MANUAL" ? (
                            <Checkbox
                              label={product.title}
                              checked={selection.productIds.includes(
                                product.id,
                              )}
                              onChange={(checked) =>
                                changeSelection({
                                  productIds: checked
                                    ? [...selection.productIds, product.id]
                                    : selection.productIds.filter(
                                        (id) => id !== product.id,
                                      ),
                                })
                              }
                            />
                          ) : (
                            <Text as="p" fontWeight="semibold">
                              {product.title}
                            </Text>
                          )}
                          <Text as="p" variant="bodySm" tone="subdued">
                            {product.handle}
                          </Text>
                        </BlockStack>
                        <InlineStack gap="200">
                          <Badge>{label(product.status)}</Badge>
                          <Badge tone="info">{label(product.state)}</Badge>
                        </InlineStack>
                      </InlineStack>
                    </Box>
                  ))
                ) : (
                  <Text as="p" tone="subdued">
                    No products match. Adjust the filters or select products to
                    continue.
                  </Text>
                )}
                <InlineStack align="space-between" blockAlign="center">
                  <Text as="p" tone="subdued">
                    Page {currentPreview.page} of {currentPreview.pageCount} ·{" "}
                    {currentPreview.count} results
                  </Text>
                  <Pagination
                    hasPrevious={(currentPreview.page || 1) > 1}
                    hasNext={
                      (currentPreview.page || 1) <
                      (currentPreview.pageCount || 1)
                    }
                    onPrevious={() => setPage((currentPreview.page || 1) - 1)}
                    onNext={() => setPage((currentPreview.page || 1) + 1)}
                  />
                </InlineStack>
              </BlockStack>
            )}
          </BlockStack>
        </Modal.Section>
      </Modal>
    </BlockStack>
  );
}

const features = [
  {
    title: "Sync Rules",
    description:
      "Choose which products and fields move between stores. Run syncs manually, in real time, or on a schedule.",
    action: "Manage sync rules",
    url: "/app/sync-rules",
  },
  {
    title: "Price Rules",
    description:
      "Adjust destination prices with percentage or fixed changes, currency conversion, and price rounding.",
    action: "Manage price rules",
    url: "/app/price-rules",
  },
  {
    title: "Collection Sync",
    description:
      "Map source collections to destination collections and control how their products stay aligned.",
    action: "Manage collections",
    url: "/app/collection-mapping",
  },
  {
    title: "Inventory Sync",
    description:
      "Keep stock quantities aligned between stores using dedicated inventory rules and location settings.",
    action: "Manage inventory sync",
    url: "/app/inventory-sync",
  },
];
export function FeatureShortcuts() {
  return (
    <BlockStack gap="300">
      <Text as="h2" variant="headingLg">
        Make the most of Store Sync
      </Text>
      <InlineGrid columns={{ xs: 1, sm: 2 }} gap="400">
        {features.map((feature) => (
          <Card key={feature.title}>
            <BlockStack gap="300">
              <Text as="h3" variant="headingMd">
                {feature.title}
              </Text>
              <Text as="p" tone="subdued">
                {feature.description}
              </Text>
              <InlineStack>
                <Button url={feature.url}>{feature.action}</Button>
              </InlineStack>
            </BlockStack>
          </Card>
        ))}
      </InlineGrid>
    </BlockStack>
  );
}
