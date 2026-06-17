import type { HeadersFunction, LoaderFunctionArgs } from "@remix-run/node";
import { Link, Outlet, useLoaderData, useRouteError } from "@remix-run/react";
import { boundary } from "@shopify/shopify-app-remix/server";
import { AppProvider } from "@shopify/shopify-app-remix/react";
import { NavMenu } from "@shopify/app-bridge-react";
import polarisStyles from "@shopify/polaris/build/esm/styles.css?url";

import { authenticate } from "../shopify.server";
import { withDbRetry } from "../utils/db-retry.server";

export const links = () => [{ rel: "stylesheet", href: polarisStyles }];

export const loader = async ({ request }: LoaderFunctionArgs) => {
  // authenticate.admin reads the session from the Prisma-backed session store.
  // On hosted Postgres a transient connection blip would otherwise bubble up as
  // a bare "Application Error" for the WHOLE embedded app (this is the parent
  // layout). withDbRetry retries only transient DB errors and immediately
  // re-throws auth redirect Responses, so the OAuth/reauth flow is unaffected.
  await withDbRetry(() => authenticate.admin(request));
  return { apiKey: process.env.SHOPIFY_API_KEY || "" };
};

export default function App() {
  const { apiKey } = useLoaderData<typeof loader>();

  return (
    <AppProvider isEmbeddedApp apiKey={apiKey}>
      <NavMenu>
        <Link to="/app" rel="home">
          Dashboard
        </Link>
        <Link to="/app/stores">Stores</Link>
        <Link to="/app/sync-rules">Sync Rules</Link>
        <Link to="/app/price-rules">Price Rules</Link>
        <Link to="/app/collection-mapping">Collections</Link>
        <Link to="/app/bulk-sync">Bulk Sync</Link>
        <Link to="/app/analytics">Analytics</Link>
        <Link to="/app/activity">Activity</Link>
        <Link to="/app/retry-dashboard">Retries</Link>
        <Link to="/app/logs">Sync Logs</Link>
        <Link to="/app/billing">Billing</Link>
        <Link to="/app/settings">Settings</Link>
      </NavMenu>
      <Outlet />
    </AppProvider>
  );
}

export function ErrorBoundary() {
  return boundary.error(useRouteError());
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
