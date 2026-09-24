-- Admin-editable organization profile details.
--
-- Purely additive: four nullable columns, no defaults, no backfill, no
-- rewrite of existing rows. Existing organizations keep working with every
-- new column NULL, which is exactly what "not filled in yet" means.
--
-- `emailDomain` is deliberately untouched. It is the key that routes signups
-- to an org and is not exposed as an editable field.
ALTER TABLE "Organization" ADD COLUMN "website" TEXT;
ALTER TABLE "Organization" ADD COLUMN "industry" TEXT;
ALTER TABLE "Organization" ADD COLUMN "location" TEXT;
ALTER TABLE "Organization" ADD COLUMN "description" TEXT;
