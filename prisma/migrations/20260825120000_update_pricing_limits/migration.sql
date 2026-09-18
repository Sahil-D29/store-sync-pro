-- Update subscription product limits to match the revised Shopify App Pricing tiers.
ALTER TABLE "Subscription" ALTER COLUMN "productLimit" SET DEFAULT 50;

UPDATE "Subscription"
SET "productLimit" = CASE "plan"
  WHEN 'FREE' THEN 50
  WHEN 'BASIC' THEN 200
  WHEN 'PRO' THEN 500
  WHEN 'ENTERPRISE' THEN 999999999
  ELSE "productLimit"
END;
