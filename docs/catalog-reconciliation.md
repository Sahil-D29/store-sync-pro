# Dashboard catalog reconciliation

The homepage shows connected-store product counts even when no sync rule exists.
`GET /api/store-counts/:storeId` reads account-scoped Shopify counts independently
for each store; errors in one store do not hide the other store's totals. The
unlimited count query falls back to pagination if Shopify returns bounded counts.
Matching and remaining-product selection require an active product sync rule.
Whole-store
counts include Active, Draft, Unlisted and Archived products. The reconciliation
counts apply the saved rule's eligibility filters. Counts come from fully
paginated catalog reads, rather than subtracting store totals.

`GET /api/catalog?ruleId=...` returns account-scoped summary counts, source filter
options and job progress. `POST /api/catalog` accepts JSON with `ruleId` and
`intent`: `COMPARE`, `MATCH`, `SYNC`, or `preview`. Preview and sync accept a
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
