export interface MetafieldData {
  namespace: string;
  key: string;
  value: string;
  type: string;
}

export interface SkippedMetafield {
  metafield: MetafieldData;
  reason: string;
}

export interface SanitizedMetafields {
  metafields: MetafieldData[];
  skipped: SkippedMetafield[];
}

const MAX_SHOPIFY_METAFIELD_VALUE_BYTES = 131_072;
const SHOPIFY_GID_PATTERN = /gid:\/\/shopify\/[A-Za-z]+\/[A-Za-z0-9_-]+/;
const REFERENCE_METAFIELD_TYPES = [
  "metaobject_reference",
  "file_reference",
  "product_reference",
  "variant_reference",
  "collection_reference",
  "page_reference",
];

function metafieldName(metafield: MetafieldData) {
  return `${metafield.namespace}.${metafield.key}`;
}

function isReferenceMetafieldType(type: string) {
  const normalized = type.toLowerCase();
  return REFERENCE_METAFIELD_TYPES.some((referenceType) =>
    normalized.includes(referenceType)
  );
}

function getSkipReason(metafield: MetafieldData): string | null {
  const value = String(metafield.value ?? "");
  const valueBytes = Buffer.byteLength(value, "utf8");

  if (valueBytes > MAX_SHOPIFY_METAFIELD_VALUE_BYTES) {
    return `value is ${valueBytes} bytes, above Shopify's ${MAX_SHOPIFY_METAFIELD_VALUE_BYTES} byte limit`;
  }

  if (isReferenceMetafieldType(String(metafield.type || ""))) {
    return `type ${metafield.type} references source-store resources that are not mapped on the destination store`;
  }

  if (SHOPIFY_GID_PATTERN.test(value)) {
    return "value contains a Shopify GID that may not exist on the destination store";
  }

  return null;
}

export function sanitizeMetafieldsForDestination(
  metafields: MetafieldData[]
): SanitizedMetafields {
  const sanitized: MetafieldData[] = [];
  const skipped: SkippedMetafield[] = [];

  for (const metafield of metafields) {
    const normalizedMetafield = {
      namespace: metafield.namespace,
      key: metafield.key,
      value: String(metafield.value ?? ""),
      type: metafield.type,
    };
    const reason = getSkipReason(normalizedMetafield);

    if (reason) {
      skipped.push({ metafield: normalizedMetafield, reason });
    } else {
      sanitized.push(normalizedMetafield);
    }
  }

  return { metafields: sanitized, skipped };
}

export function logSkippedMetafields(
  skipped: SkippedMetafield[],
  context: string
) {
  for (const skippedMetafield of skipped) {
    console.warn(
      `[MetafieldSync] Skipping ${metafieldName(skippedMetafield.metafield)} during ${context}: ${skippedMetafield.reason}`
    );
  }
}
