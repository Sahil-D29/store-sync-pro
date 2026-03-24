/**
 * Stream-friendly JSONL parser for Shopify Bulk Operations results.
 * Parses JSONL text and reassembles parent-child relationships.
 */

export interface ParsedProduct {
  id: string;
  [key: string]: any;
  __children: ParsedChild[];
}

export interface ParsedChild {
  __parentId: string;
  [key: string]: any;
}

/**
 * Parse JSONL text into parent objects with their children grouped.
 * Shopify JSONL format: parent objects have `id`, children have `__parentId`.
 */
export function parseJsonl(text: string): Map<string, ParsedProduct> {
  const products = new Map<string, ParsedProduct>();
  const lines = text.split("\n");

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    try {
      const obj = JSON.parse(trimmed);

      if (obj.__parentId) {
        // Child object - attach to parent
        const parent = products.get(obj.__parentId);
        if (parent) {
          parent.__children.push(obj);
        }
      } else if (obj.id) {
        // Parent object
        products.set(obj.id, { ...obj, __children: [] });
      }
    } catch {
      // Skip malformed lines
    }
  }

  return products;
}

/**
 * Extract variants from a parsed product's children.
 */
export function extractVariants(product: ParsedProduct): any[] {
  return product.__children.filter(
    (c) => c.id && c.id.includes("ProductVariant")
  );
}

/**
 * Extract metafields from a parsed product's children.
 */
export function extractMetafields(product: ParsedProduct): any[] {
  return product.__children.filter(
    (c) => c.namespace && c.key
  );
}

/**
 * Extract images from a parsed product's children.
 */
export function extractImages(product: ParsedProduct): any[] {
  return product.__children.filter(
    (c) => c.url && !c.namespace
  );
}

/**
 * Stream-parse JSONL from a URL without loading entire file in memory.
 * Processes line-by-line using a ReadableStream.
 */
export async function streamParseJsonlUrl(
  url: string,
  onProduct: (product: ParsedProduct) => Promise<void>
): Promise<{ processed: number; errors: number }> {
  const response = await fetch(url);
  if (!response.ok || !response.body) {
    throw new Error(`Failed to fetch JSONL: ${response.status}`);
  }

  let processed = 0;
  let errors = 0;
  const pendingProducts = new Map<string, ParsedProduct>();
  const orphanChildren: ParsedChild[] = [];

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    // Keep the last potentially incomplete line in the buffer
    buffer = lines.pop() || "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      try {
        const obj = JSON.parse(trimmed);

        if (obj.__parentId) {
          const parent = pendingProducts.get(obj.__parentId);
          if (parent) {
            parent.__children.push(obj);
          } else {
            orphanChildren.push(obj);
          }
        } else if (obj.id) {
          const product: ParsedProduct = { ...obj, __children: [] };
          // Attach any orphan children
          const orphans = orphanChildren.filter((c) => c.__parentId === obj.id);
          product.__children.push(...orphans);
          pendingProducts.set(obj.id, product);
        }
      } catch {
        errors++;
      }
    }
  }

  // Process remaining buffer
  if (buffer.trim()) {
    try {
      const obj = JSON.parse(buffer.trim());
      if (obj.__parentId) {
        const parent = pendingProducts.get(obj.__parentId);
        if (parent) parent.__children.push(obj);
      } else if (obj.id) {
        pendingProducts.set(obj.id, { ...obj, __children: [] });
      }
    } catch {
      errors++;
    }
  }

  // Emit all products
  for (const product of pendingProducts.values()) {
    try {
      await onProduct(product);
      processed++;
    } catch {
      errors++;
    }
  }

  return { processed, errors };
}
