// ─── Cosmetics Seed ───────────────────────────────────────────────────────────
//
// Seeds the `cosmetics` table from prisma/seeds/cosmetics_catalog.json.
// Idempotent — uses `upsert` per row so re-running is safe and updates
// changed fields (price tweaks, new limited-time windows, etc.).
//
// ── Sync ritual ──
// The catalog of record currently lives in the iOS repo at:
//   ~/Desktop/StackPoker/Features/Cosmetics/Resources/cosmetics_catalog.json
//
// When iOS adds, removes, or edits a cosmetic, copy the JSON here:
//   cp ~/Desktop/StackPoker/Features/Cosmetics/Resources/cosmetics_catalog.json \
//      ~/Desktop/StackPoker-backend/prisma/seeds/cosmetics_catalog.json
// then run:
//   npm run seed:cosmetics
//
// The DB is the runtime source of truth at purchase time — the JSON here is
// only the seed/sync artifact. In Phase 5 (LiveOps), this script is replaced
// by an admin endpoint that writes to `cosmetics` directly.
//
// Rows present in the DB but absent from the JSON are NOT deleted — historical
// purchases reference them via CosmeticOwnership.cosmeticId (FK ON DELETE
// RESTRICT). If a cosmetic must be retired, mark `availableUntil` to a past
// date instead so existing owners keep their item but new buyers see
// COSMETIC_NOT_AVAILABLE.

import { PrismaClient } from '@prisma/client';
import * as fs from 'fs';
import * as path from 'path';

interface CatalogEntry {
  id: string;
  name: string;
  category: string;
  rarity: string;
  priceChips?: number;           // optional — null means "not purchasable"; JSON number → BigInt at write
  previewAssetName?: string;
  unlockCondition?: string;      // defaults to "purchase" in schema
  isLimitedTime?: boolean;
  availableUntil?: string;       // ISO 8601 → DateTime
}

// Mirrors the `cosmetics_price_purchase_invariant` CHECK constraint in
// migrations/20260515025241_price_nullable_with_check. Application-level
// validation surfaces bad rows with a usable error before the DB rejects
// them on insert.
function validateEntry(c: CatalogEntry): string | null {
  const unlock     = c.unlockCondition ?? 'purchase';
  const hasPrice   = c.priceChips !== undefined && c.priceChips !== null;
  const isPurchase = unlock === 'purchase';

  if (isPurchase && !hasPrice) {
    return `unlockCondition='purchase' but priceChips is missing/null`;
  }
  if (!isPurchase && hasPrice) {
    return `unlockCondition='${unlock}' (non-purchase) but priceChips=${c.priceChips} is set`;
  }
  return null;
}

interface Catalog {
  _meta?: unknown;
  cosmetics: CatalogEntry[];
}

async function main() {
  const prisma = new PrismaClient();

  const jsonPath = path.join(__dirname, 'cosmetics_catalog.json');
  const raw = fs.readFileSync(jsonPath, 'utf-8');
  const catalog = JSON.parse(raw) as Catalog;

  if (!Array.isArray(catalog.cosmetics)) {
    throw new Error(`Malformed catalog at ${jsonPath} — expected "cosmetics" array`);
  }

  // ── Pre-flight validation ──────────────────────────────────────────────
  // Refuse to seed if ANY row violates the price/unlock invariant. Don't
  // paper over the inconsistency by skipping bad rows — surface the data
  // bug loudly so the catalog gets fixed at the source.
  const violations: { id: string; reason: string }[] = [];
  for (const c of catalog.cosmetics) {
    const reason = validateEntry(c);
    if (reason) violations.push({ id: c.id, reason });
  }
  if (violations.length > 0) {
    console.error(`[seed:cosmetics] REFUSING TO SEED — ${violations.length} invariant violation(s):`);
    for (const v of violations) {
      console.error(`  • ${v.id}: ${v.reason}`);
    }
    console.error('Fix prisma/seeds/cosmetics_catalog.json and re-run.');
    process.exit(2);
  }

  console.log(`[seed:cosmetics] upserting ${catalog.cosmetics.length} rows…`);

  let inserted = 0;
  let updated  = 0;

  for (const c of catalog.cosmetics) {
    const data = {
      name:             c.name,
      category:         c.category,
      rarity:           c.rarity,
      priceChips:       c.priceChips !== undefined && c.priceChips !== null
                          ? BigInt(c.priceChips)
                          : null,
      previewAssetName: c.previewAssetName ?? null,
      unlockCondition:  c.unlockCondition ?? 'purchase',
      isLimitedTime:    c.isLimitedTime ?? false,
      availableUntil:   c.availableUntil ? new Date(c.availableUntil) : null,
    };

    const existing = await prisma.cosmetic.findUnique({ where: { id: c.id } });

    await prisma.cosmetic.upsert({
      where:  { id: c.id },
      create: { id: c.id, ...data },
      update: data,
    });

    if (existing) updated++; else inserted++;
  }

  const total = await prisma.cosmetic.count();
  console.log(`[seed:cosmetics] inserted=${inserted} updated=${updated} totalInDB=${total}`);

  await prisma.$disconnect();
}

main().catch(async (err) => {
  console.error('[seed:cosmetics] FAILED', err);
  process.exit(1);
});
