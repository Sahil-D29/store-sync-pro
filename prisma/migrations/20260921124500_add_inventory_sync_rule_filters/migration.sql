ALTER TABLE "InventorySyncRule"
ADD COLUMN "filterType" "FilterType" NOT NULL DEFAULT 'ALL',
ADD COLUMN "filterCollectionIds" TEXT,
ADD COLUMN "filterProductIds" TEXT,
ADD COLUMN "filterTags" TEXT;
