-- AlterTable
ALTER TABLE "cosmetics" ALTER COLUMN "priceChips" DROP NOT NULL;

-- ─── Cosmetic price/purchase invariant ───────────────────────────────────────
-- Enforces the two-column rule at the DB level so future admin endpoints,
-- direct prisma writes, or hand-edited rows in production cannot violate it:
--
--   priceChips IS NULL       ⇔  unlockCondition <> 'purchase'
--   unlockCondition = 'purchase' ⇒  priceChips IS NOT NULL
--
-- Mirrors the validator in prisma/seeds/cosmetics.ts. Application-level
-- validation is the first line of defense; this constraint is the safety net.
ALTER TABLE "cosmetics"
  ADD CONSTRAINT "cosmetics_price_purchase_invariant"
  CHECK (
    ("unlockCondition" = 'purchase' AND "priceChips" IS NOT NULL)
    OR
    ("unlockCondition" <> 'purchase' AND "priceChips" IS NULL)
  );
