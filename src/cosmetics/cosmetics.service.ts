import { PrismaClient, Prisma } from '@prisma/client';
import { logger } from '../shared/utils';

const prisma = new PrismaClient();

// ─── Error codes ──────────────────────────────────────────────────────────────
//
// Stable strings — iOS NetworkPurchasePort+Live.swift switches on these.
// Add new codes by appending; never rename existing ones without a coordinated
// iOS release.

export interface CodedError {
  code: string;
  message: string;
  status: number;
}

const err = (code: string, message: string, status: number): CodedError => ({ code, message, status });

// ─── Purchase ────────────────────────────────────────────────────────────────
//
// Server-authoritative atomic purchase. Wraps everything in $transaction so a
// burst of concurrent requests from the same user can never double-spend or
// double-grant.
//
// Flow:
//   1. Look up cosmetic; reject if not found.
//   2. Validate purchasability (unlockCondition + priceChips invariant).
//   3. Validate availability window (server time only).
//   4. If client supplied `expectedPrice`, validate against server price.
//   5. Atomic conditional decrement via updateMany — if balance < price the
//      WHERE clause matches zero rows and count===0 → INSUFFICIENT_CHIPS.
//   6. Create ownership row. Catches P2002 unique violation → ALREADY_OWNED.
//   7. Create ledger row (ChipTransaction, type=PURCHASE, amount = -price).
//   8. Return { newBalance, ownedCosmeticId, granted:true }.
//
// updateMany + WHERE chipBalance >= price is the race-safe pattern: even if
// two requests interleave between the SELECT-for-balance and the UPDATE, the
// SQL UPDATE itself is atomic — at most one of them can succeed against a
// balance that supports the price. (Postgres row-level locking inside the
// transaction blocks the second update until the first commits.)

export async function purchaseCosmetic(
  userId: string,
  cosmeticId: string,
  expectedPrice?: string,        // optional BigInt-as-string for PRICE_MISMATCH check
): Promise<{ newBalance: string; ownedCosmeticId: string; granted: true }> {

  // 1+2+3+4 — read-only validation outside the transaction. These don't need
  // to run under SERIALIZABLE; they're fast enough and any race here is
  // caught by the unique constraint / conditional decrement inside the txn.
  const cosmetic = await prisma.cosmetic.findUnique({ where: { id: cosmeticId } });
  if (!cosmetic) {
    throw err('COSMETIC_NOT_FOUND', 'Cosmetic does not exist', 404);
  }

  // Purchasability invariant — mirrored by the DB CHECK constraint, but we
  // check here too so we can surface a meaningful error code instead of a
  // generic constraint violation.
  if (cosmetic.unlockCondition !== 'purchase' || cosmetic.priceChips === null) {
    throw err('COSMETIC_NOT_PURCHASABLE', 'Cosmetic is not purchasable', 409);
  }

  // Availability window — server time only.
  if (cosmetic.isLimitedTime && cosmetic.availableUntil && cosmetic.availableUntil < new Date()) {
    throw err('COSMETIC_NOT_AVAILABLE', 'Limited-time window has closed', 410);
  }

  const price = cosmetic.priceChips; // BigInt, non-null after the guard above

  // Price-of-record check. Optional in the request because the existing iOS
  // client hasn't been updated to send it yet; once it does, this becomes
  // a critical safety net against catalog/client drift.
  if (expectedPrice !== undefined) {
    let parsed: bigint;
    try {
      parsed = BigInt(expectedPrice);
    } catch {
      throw err('PRICE_MISMATCH', 'expectedPrice is not a valid integer', 409);
    }
    if (parsed !== price) {
      throw err('PRICE_MISMATCH', `Client expected ${parsed}, server price is ${price}`, 409);
    }
  }

  // 5+6+7 — atomic critical section.
  try {
    const result = await prisma.$transaction(async (tx) => {
      // Conditional decrement. count===0 means the WHERE didn't match — i.e.
      // either user doesn't exist or chipBalance < price.
      const decremented = await tx.user.updateMany({
        where: { id: userId, chipBalance: { gte: price } },
        data:  { chipBalance: { decrement: price } },
      });
      if (decremented.count === 0) {
        throw err('INSUFFICIENT_CHIPS', 'Not enough chips', 400);
      }

      // Insert ownership. Unique constraint (userId, cosmeticId) catches
      // double-buy. Prisma surfaces this as P2002.
      await tx.cosmeticOwnership.create({
        data: { userId, cosmeticId },
      });

      // Ledger entry. recipientId = buyer (chips "deducted from" them by
      // sending TO themselves, with the amount sign carried by the type).
      // Amount stored as positive; type=PURCHASE signals direction.
      await tx.chipTransaction.create({
        data: {
          recipientId: userId,
          amount:      price,
          type:        'PURCHASE',
          description: `Purchased cosmetic ${cosmeticId}`,
        },
      });

      // Re-read balance for the response.
      const after = await tx.user.findUnique({
        where: { id: userId },
        select: { chipBalance: true },
      });
      // If this is null, the user was deleted mid-transaction — vanishingly
      // unlikely but if it happens the transaction will be rolled back when
      // we throw, so we still return a coherent state.
      if (!after) throw err('COSMETIC_NOT_FOUND', 'User vanished mid-purchase', 500);
      return after.chipBalance;
    });

    logger.info(`Cosmetic purchased: user=${userId} cosmetic=${cosmeticId} price=${price.toString()}`);
    return {
      newBalance:      result.toString(),
      ownedCosmeticId: cosmeticId,
      granted:         true,
    };

  } catch (e) {
    // Already-formatted CodedError — rethrow unchanged.
    if (isCodedError(e)) throw e;

    // P2002 = unique constraint violation on (userId, cosmeticId) → double-buy.
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
      throw err('ALREADY_OWNED', 'Cosmetic already owned', 409);
    }

    // Anything else is an unexpected DB error — let it bubble to the route
    // handler which will return SERVER_ERROR (500).
    logger.error(`Purchase txn failed: user=${userId} cosmetic=${cosmeticId}`, e);
    throw e;
  }
}

function isCodedError(e: unknown): e is CodedError {
  return typeof e === 'object' && e !== null
    && 'code' in e && 'message' in e && 'status' in e;
}

// ─── Equip ───────────────────────────────────────────────────────────────────
//
// Server-authoritative equip. Phase 4 vertical slice; takes over from the
// previously iOS-local equip state (InventoryRepository.swift) so that
// per-seat broadcast (Commit 2) can read a single source of truth and
// opponents at the table see what each player has equipped.
//
// Flow:
//   1. Look up cosmetic; reject if not found.
//   2. Reject if the requested category doesn't match the cosmetic's category
//      — iOS picks the category from the cosmetic itself, so a mismatch is a
//      client bug that we want to surface loudly rather than silently rewrite.
//   3. Confirm the user owns the cosmetic (CosmeticOwnership row exists).
//      Without this guard a malicious client could equip anything in the
//      catalog. Authoritative ownership lives in DB; we don't trust the client.
//   4. Upsert EquippedCosmetic on (userId, category) — replaces any existing
//      equip in that slot. The @@unique([userId, category]) constraint makes
//      this race-safe; Prisma's upsert handles "row exists" without a manual
//      pre-check.
//
// Returns the new equipped state for the category so iOS can update its
// local cache without a separate roundtrip.

export async function equipCosmetic(
  userId: string,
  cosmeticId: string,
  category: string,
): Promise<{ category: string; cosmeticId: string }> {

  const cosmetic = await prisma.cosmetic.findUnique({ where: { id: cosmeticId } });
  if (!cosmetic) {
    throw err('COSMETIC_NOT_FOUND', 'Cosmetic does not exist', 404);
  }

  // Category match — the client must request equip in the cosmetic's own
  // category. Reject mismatches as a client-bug signal.
  if (cosmetic.category !== category) {
    throw err(
      'CATEGORY_MISMATCH',
      `Cosmetic belongs to '${cosmetic.category}', not '${category}'`,
      409,
    );
  }

  // Ownership check — Prisma findUnique on the (userId, cosmeticId) composite.
  const ownership = await prisma.cosmeticOwnership.findUnique({
    where: { userId_cosmeticId: { userId, cosmeticId } },
  });
  if (!ownership) {
    throw err('NOT_OWNED', 'User does not own this cosmetic', 403);
  }

  // Upsert. The composite unique (userId, category) means there's at most
  // one row to update; if it doesn't exist yet, create it. Atomic relative
  // to other concurrent equips because Postgres serializes on the unique
  // index.
  await prisma.equippedCosmetic.upsert({
    where:  { userId_category: { userId, category } },
    update: { cosmeticId, equippedAt: new Date() },
    create: { userId, category, cosmeticId },
  });

  logger.info(`Cosmetic equipped: user=${userId} category=${category} cosmetic=${cosmeticId}`);
  return { category, cosmeticId };
}

// ─── Unequip ─────────────────────────────────────────────────────────────────
//
// Removes the EquippedCosmetic row for (userId, category). Idempotent — if
// no row exists, returns successfully without throwing. iOS treats the
// response as "this slot is now empty" regardless of prior state.

export async function unequipCosmetic(
  userId: string,
  category: string,
): Promise<{ category: string; cosmeticId: null }> {

  // deleteMany rather than delete: delete throws P2025 when no row matches,
  // deleteMany silently no-ops with count=0. We want idempotent behavior so
  // a retry from a flaky network doesn't surface a confusing error.
  await prisma.equippedCosmetic.deleteMany({
    where: { userId, category },
  });

  logger.info(`Cosmetic unequipped: user=${userId} category=${category}`);
  return { category, cosmeticId: null };
}

// ─── Inventory ───────────────────────────────────────────────────────────────
//
// One-call snapshot for iOS app-load. Returns:
//   - ownedIds:  array of cosmetic ids the user owns
//   - equipped:  map of category → cosmeticId for slots the user has equipped
//
// Empty arrays / empty map for users who own nothing — no error, no special
// case. iOS treats this as the canonical state and overwrites its local
// UserDefaults cache.

export async function getUserInventory(
  userId: string,
): Promise<{ ownedIds: string[]; equipped: { [category: string]: string } }> {

  const [ownerships, equipped] = await Promise.all([
    prisma.cosmeticOwnership.findMany({
      where:  { userId },
      select: { cosmeticId: true },
    }),
    prisma.equippedCosmetic.findMany({
      where:  { userId },
      select: { category: true, cosmeticId: true },
    }),
  ]);

  const equippedMap: { [category: string]: string } = {};
  for (const e of equipped) {
    equippedMap[e.category] = e.cosmeticId;
  }

  return {
    ownedIds: ownerships.map(o => o.cosmeticId),
    equipped: equippedMap,
  };
}

// ─── Bulk equipped lookup (for seat broadcast) ───────────────────────────────
//
// Commit 2 will use this to hydrate `Seat.equippedCosmetics` at table-join.
// One query per table-join regardless of seat count — single findMany with
// `userId in [...]`.

export async function getEquippedForUsers(
  userIds: string[],
): Promise<Map<string, { [category: string]: string }>> {

  if (userIds.length === 0) return new Map();

  const rows = await prisma.equippedCosmetic.findMany({
    where:  { userId: { in: userIds } },
    select: { userId: true, category: true, cosmeticId: true },
  });

  const out = new Map<string, { [category: string]: string }>();
  for (const r of rows) {
    let slot = out.get(r.userId);
    if (!slot) {
      slot = {};
      out.set(r.userId, slot);
    }
    slot[r.category] = r.cosmeticId;
  }
  return out;
}
