# Dashboard catalog reconciliation

The homepage shows connected-store product counts even when no sync rule exists.
`GET /api/store-counts/:storeId` reads account-scoped Shopify counts independently
for each store; errors in one store do not hide the other store's totals. The
unlimited count query falls back to pagination if Shopify returns bounded counts.
The homepage's **Add missing products** action works without prior rule setup:
select a source and destination, then filter and preview the products to copy.
Preparation creates or reuses a manual-only product rule and starts a comparison;
it does not write Shopify products or enable scheduled/realtime syncing.
Missing means neither a valid destination mapping nor an identical destination
handle exists. Existing products are excluded even if never mapped by the app.
The `missingOnly` selection flag is revalidated before each create; a concurrent
handle collision is skipped instead of taking the normal update fallback.
The existing rule-based match and remaining-product update flows remain available.
The homepage now separates **Add missing (count)** from **Update existing
products**. Add previews contain only missing products; update previews contain
only existing products, including previously synced ones. Status, collection,
tag and manual selections narrow each operation's own product set.

Both dialogs offer saved price rules plus a create-rule link. Pricing defaults
to unchanged source prices. An optional `selection.priceRuleId` is checked against
the owning account and applied in memory for that operation; the saved sync
rule's price configuration is never modified. `selection.existingOnly` makes
updates skip absent or concurrently deleted destination products, without using
the sync engine's normal create fallback. It cannot be combined with `missingOnly`.
Whole-store
counts include Active, Draft, Unlisted and Archived products. The reconciliation
counts apply the saved rule's eligibility filters. Counts come from fully
paginated catalog reads, rather than subtracting store totals.

`GET /api/catalog?ruleId=...` returns account-scoped summary counts, source filter
options and job progress. `POST /api/catalog` accepts JSON with `ruleId` and
`intent`: `COMPARE`, `MATCH`, `SYNC`, `PREPARE_MISSING`, or `preview`.
`PREPARE_MISSING` takes `sourceStoreId` and `destStoreId` and returns the manual
rule and comparison job. Preview and sync accept a
`selection` with `statuses`, `method`, `collectionIds`, `tags`, `productIds`, and
`tagMode`. Sync also requires the preview's `snapshotId`. Preview supports search,
20-product pages, and manual browsing; search never changes selection membership.

Selections intersect the rule's remaining products with chosen statuses and one
selection method. Matching only creates local mappings using exact handles and
unambiguous variant option combinations. It makes no Shopify product mutations
and does not increment usage. Sync updates matched products or creates missing
products using existing rule settings and billing checks. Variant conflicts and
products exceeding the existing sync engine's 100-variant limit are reported
without product updates.

Jobs run in the web process, as existing manual syncs do. Progress and completed
snapshots persist in `CatalogJob`; a unique store-pair lease and PostgreSQL
advisory locks prevent concurrent dashboard/manual jobs for the same pair. Leases
heartbeat every 20 seconds. An interrupted process's jobs become failed and release
their leases after five minutes without a heartbeat, on the next catalog request.
They can then be refreshed/retried; they do not resume automatically.

## Deployment

Apply the included Prisma migration before starting the updated application:

```sh
npm run setup
npm run build
```

The existing Docker start command already runs setup/migrations. No new package,
Shopify scope, or manual Shopify app configuration change is required.

## Checks

```sh
npx tsc --noEmit
node --import tsx --test scripts/catalog-selection.test.ts
```

For integration coverage, create a disposable local PostgreSQL database, set
`DATABASE_URL` to it, and run `npx prisma migrate deploy`. Then set
`CATALOG_TEST_DATABASE_URL` to the same localhost URL and run:

```sh
node --import tsx --test scripts/catalog-reconciliation.integration.test.ts
```

Integration tests mock Shopify transport and exercise actual Prisma/PostgreSQL
queries, job locks, selection revalidation, matching, selective product writes,
retries, billing limits, partial API failure, and account isolation. They refuse a
non-local test database and remove only their own fixtures.
