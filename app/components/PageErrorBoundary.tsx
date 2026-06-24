import { useRouteError } from "@remix-run/react";
import { Page, Card, BlockStack, Text, Button } from "@shopify/polaris";

/**
 * Shared route ErrorBoundary so a transient loader/render failure shows a
 * friendly "reload" card instead of the bare embedded "Application Error" page.
 * Re-export from a route as: export { PageErrorBoundary as ErrorBoundary } from ...
 */
export function PageErrorBoundary() {
  const error = useRouteError();
  return (
    <Page>
      <Card>
        <BlockStack gap="300">
          <Text as="h2" variant="headingMd">
            Something went wrong
          </Text>
          <Text as="p" tone="subdued">
            {error instanceof Error
              ? error.message
              : "A temporary error occurred. Please reload the page."}
          </Text>
          <Button onClick={() => window.location.reload()}>Reload page</Button>
        </BlockStack>
      </Card>
    </Page>
  );
}
