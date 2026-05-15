// ─── Cosmetics purchase — service integration tests ──────────────────────────
//
// Service-level integration tests against the real dev DB. Validates every
// error code from the purchase endpoint plus two concurrency scenarios that
// only show up when the real Postgres row-locking + unique-constraint
// machinery is involved (a mocked Prisma can't catch double-spend races).
//
// Test fixtures (created in beforeAll, deleted in afterAll):
//   - 1 test user with a predictable starting balance
//   - 4 test cosmetics with distinct unlockCondition / availability shapes
//     so each error path has a deterministic target
//
// VALIDATION_ERROR (422) is not covered here — it's express-validator
// behavior at the route layer, exercised by curl in the smoke step.
// RATE_LIMITED is intentionally skipped per user request.

import { PrismaClient } from '@prisma/client';
import { purchaseCosmetic } from '../src/cosmetics/cosmetics.service';

const prisma = new PrismaClient();

const TEST_USER_ID         = '00000000-0000-0000-0000-0000000c05de';
const TEST_USER_USERNAME   = 'cosmetics_test_user';
const TEST_USER_BALANCE    = 10_000n;

const COSMETIC_BUYABLE      = 'test_purchase_buyable';      // priceChips=1000, purchase
const COSMETIC_EXPENSIVE    = 'test_purchase_expensive';    // priceChips=1e12, purchase
const COSMETIC_NON_PURCHASE = 'test_achievement_only';      // priceChips=null, achievement
const COSMETIC_EXPIRED      = 'test_limited_expired';       // priceChips=500, purchase, availableUntil=past

beforeAll(async () => {
  // ── Test user — created with raw values so we don't depend on signup flow.
  // Username includes randomness so parallel test runs don't collide.
  await prisma.user.upsert({
    where:  { id: TEST_USER_ID },
    create: {
      id:          TEST_USER_ID,
      username:    `${TEST_USER_USERNAME}_${Date.now()}`,
      displayName: 'Cosmetics Test User',
      chipBalance: TEST_USER_BALANCE,
    },
    update: { chipBalance: TEST_USER_BALANCE },
  });

  // ── Test cosmetics — clean slate.
  await prisma.cosmetic.deleteMany({
    where: { id: { in: [
      COSMETIC_BUYABLE, COSMETIC_EXPENSIVE, COSMETIC_NON_PURCHASE, COSMETIC_EXPIRED,
    ] } },
  });

  await prisma.cosmetic.createMany({
    data: [
      {
        id: COSMETIC_BUYABLE,
        name: 'Buyable', category: 'test', rarity: 'common',
        priceChips: 1000n,
        unlockCondition: 'purchase',
      },
      {
        id: COSMETIC_EXPENSIVE,
        name: 'Expensive', category: 'test', rarity: 'common',
        priceChips: 1_000_000_000n,
        unlockCondition: 'purchase',
      },
      {
        id: COSMETIC_NON_PURCHASE,
        name: 'Achievement', category: 'test', rarity: 'common',
        priceChips: null,
        unlockCondition: 'achievement',
      },
      {
        id: COSMETIC_EXPIRED,
        name: 'Expired', category: 'test', rarity: 'common',
        priceChips: 500n,
        unlockCondition: 'purchase',
        isLimitedTime: true,
        availableUntil: new Date('2020-01-01T00:00:00Z'), // safely in the past
      },
    ],
  });
});

afterAll(async () => {
  // Cascading delete on User wipes ownerships; chip_transactions need explicit
  // delete (no FK cascade since they reference recipientId nullably elsewhere).
  await prisma.chipTransaction.deleteMany({ where: { recipientId: TEST_USER_ID } });
  await prisma.cosmeticOwnership.deleteMany({ where: { userId: TEST_USER_ID } });
  await prisma.user.deleteMany({ where: { id: TEST_USER_ID } });
  await prisma.cosmetic.deleteMany({
    where: { id: { in: [
      COSMETIC_BUYABLE, COSMETIC_EXPENSIVE, COSMETIC_NON_PURCHASE, COSMETIC_EXPIRED,
    ] } },
  });
  await prisma.$disconnect();
});

// Reset per-test state: balance back to known value, drop ownerships +
// ledger entries from prior tests. Keeps each test deterministic regardless
// of execution order.
async function resetUserState() {
  await prisma.cosmeticOwnership.deleteMany({ where: { userId: TEST_USER_ID } });
  await prisma.chipTransaction.deleteMany({ where: { recipientId: TEST_USER_ID } });
  await prisma.user.update({
    where: { id: TEST_USER_ID },
    data:  { chipBalance: TEST_USER_BALANCE },
  });
}

beforeEach(resetUserState);

// ─── Happy path ──────────────────────────────────────────────────────────────

describe('Cosmetics Purchase — Happy Path', () => {
  test('purchase succeeds, balance decrements, ownership + ledger rows created', async () => {
    const result = await purchaseCosmetic(TEST_USER_ID, COSMETIC_BUYABLE);

    expect(result.granted).toBe(true);
    expect(result.ownedCosmeticId).toBe(COSMETIC_BUYABLE);
    expect(result.newBalance).toBe((TEST_USER_BALANCE - 1000n).toString());

    // Balance actually decremented in DB
    const user = await prisma.user.findUnique({ where: { id: TEST_USER_ID } });
    expect(user!.chipBalance).toBe(TEST_USER_BALANCE - 1000n);

    // Ownership row exists
    const ownership = await prisma.cosmeticOwnership.findUnique({
      where: { userId_cosmeticId: { userId: TEST_USER_ID, cosmeticId: COSMETIC_BUYABLE } },
    });
    expect(ownership).not.toBeNull();

    // Ledger row exists with correct type + amount
    const txns = await prisma.chipTransaction.findMany({
      where: { recipientId: TEST_USER_ID, type: 'PURCHASE' },
    });
    expect(txns).toHaveLength(1);
    expect(txns[0].amount).toBe(1000n);
    expect(txns[0].description).toContain(COSMETIC_BUYABLE);
  });

  test('expectedPrice matching server price — no PRICE_MISMATCH', async () => {
    const result = await purchaseCosmetic(TEST_USER_ID, COSMETIC_BUYABLE, '1000');
    expect(result.granted).toBe(true);
  });
});

// ─── Error paths ─────────────────────────────────────────────────────────────

describe('Cosmetics Purchase — Error Codes', () => {

  test('COSMETIC_NOT_FOUND — unknown id → 404, no DB writes', async () => {
    await expect(purchaseCosmetic(TEST_USER_ID, 'nonexistent_cosmetic_xyz'))
      .rejects.toMatchObject({ code: 'COSMETIC_NOT_FOUND', status: 404 });

    await assertNoSideEffects();
  });

  test('COSMETIC_NOT_PURCHASABLE — achievement item → 409, no DB writes', async () => {
    await expect(purchaseCosmetic(TEST_USER_ID, COSMETIC_NON_PURCHASE))
      .rejects.toMatchObject({ code: 'COSMETIC_NOT_PURCHASABLE', status: 409 });

    await assertNoSideEffects();
  });

  test('COSMETIC_NOT_AVAILABLE — limited-time expired → 410, no DB writes', async () => {
    await expect(purchaseCosmetic(TEST_USER_ID, COSMETIC_EXPIRED))
      .rejects.toMatchObject({ code: 'COSMETIC_NOT_AVAILABLE', status: 410 });

    await assertNoSideEffects();
  });

  test('INSUFFICIENT_CHIPS — balance < price → 400, no DB writes', async () => {
    await expect(purchaseCosmetic(TEST_USER_ID, COSMETIC_EXPENSIVE))
      .rejects.toMatchObject({ code: 'INSUFFICIENT_CHIPS', status: 400 });

    await assertNoSideEffects();
  });

  test('ALREADY_OWNED — pre-existing ownership → 409, no double-charge', async () => {
    // Pre-seed an ownership row to simulate a prior purchase.
    await prisma.cosmeticOwnership.create({
      data: { userId: TEST_USER_ID, cosmeticId: COSMETIC_BUYABLE },
    });

    await expect(purchaseCosmetic(TEST_USER_ID, COSMETIC_BUYABLE))
      .rejects.toMatchObject({ code: 'ALREADY_OWNED', status: 409 });

    // Critical: balance must be unchanged. If the conditional decrement ran
    // but the create failed AFTER, the txn must roll back the decrement.
    const user = await prisma.user.findUnique({ where: { id: TEST_USER_ID } });
    expect(user!.chipBalance).toBe(TEST_USER_BALANCE);

    // No ledger entry for the rolled-back attempt.
    const txnCount = await prisma.chipTransaction.count({
      where: { recipientId: TEST_USER_ID, type: 'PURCHASE' },
    });
    expect(txnCount).toBe(0);
  });

  test('PRICE_MISMATCH — wrong expectedPrice → 409, no DB writes', async () => {
    await expect(purchaseCosmetic(TEST_USER_ID, COSMETIC_BUYABLE, '999'))
      .rejects.toMatchObject({ code: 'PRICE_MISMATCH', status: 409 });

    await assertNoSideEffects();
  });

  test('PRICE_MISMATCH — non-numeric expectedPrice → 409', async () => {
    await expect(purchaseCosmetic(TEST_USER_ID, COSMETIC_BUYABLE, 'abc'))
      .rejects.toMatchObject({ code: 'PRICE_MISMATCH', status: 409 });

    await assertNoSideEffects();
  });
});

// ─── Concurrency ─────────────────────────────────────────────────────────────
//
// These tests fire parallel service calls without awaiting between them. The
// real Postgres row-level locking inside $transaction is what gives us the
// safety guarantee — a mocked Prisma can't reproduce this, which is why
// these are real-DB integration tests.

describe('Cosmetics Purchase — Concurrency', () => {

  test('parallel purchases of same item → exactly one succeeds, one ALREADY_OWNED', async () => {
    const results = await Promise.allSettled([
      purchaseCosmetic(TEST_USER_ID, COSMETIC_BUYABLE),
      purchaseCosmetic(TEST_USER_ID, COSMETIC_BUYABLE),
    ]);

    const fulfilled = results.filter(r => r.status === 'fulfilled');
    const rejected  = results.filter(r => r.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({
      code: 'ALREADY_OWNED',
    });

    // Balance decremented exactly once
    const user = await prisma.user.findUnique({ where: { id: TEST_USER_ID } });
    expect(user!.chipBalance).toBe(TEST_USER_BALANCE - 1000n);

    // Exactly one ownership row + one ledger row
    const ownerships = await prisma.cosmeticOwnership.count({ where: { userId: TEST_USER_ID } });
    expect(ownerships).toBe(1);
    const txns = await prisma.chipTransaction.count({
      where: { recipientId: TEST_USER_ID, type: 'PURCHASE' },
    });
    expect(txns).toBe(1);
  });

  test('parallel purchases with insufficient combined budget → one succeeds, one INSUFFICIENT_CHIPS, no negative balance', async () => {
    // Squeeze user balance to 100; both items below cost 60 each → only one fits.
    await prisma.user.update({
      where: { id: TEST_USER_ID },
      data:  { chipBalance: 100n },
    });

    // Two distinct items at 60 each, both purchasable. deleteMany first so a
    // previous crashed test run can't leave orphan rows that break createMany.
    await prisma.cosmeticOwnership.deleteMany({
      where: { cosmeticId: { in: ['test_item_a', 'test_item_b'] } },
    });
    await prisma.cosmetic.deleteMany({ where: { id: { in: ['test_item_a', 'test_item_b'] } } });

    await prisma.cosmetic.createMany({
      data: [
        { id: 'test_item_a', name: 'A', category: 'test', rarity: 'common', priceChips: 60n, unlockCondition: 'purchase' },
        { id: 'test_item_b', name: 'B', category: 'test', rarity: 'common', priceChips: 60n, unlockCondition: 'purchase' },
      ],
    });

    try {
      const results = await Promise.allSettled([
        purchaseCosmetic(TEST_USER_ID, 'test_item_a'),
        purchaseCosmetic(TEST_USER_ID, 'test_item_b'),
      ]);

      const fulfilled = results.filter(r => r.status === 'fulfilled');
      const rejected  = results.filter(r => r.status === 'rejected');
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({
        code: 'INSUFFICIENT_CHIPS',
      });

      // Final balance = 40, never negative.
      const user = await prisma.user.findUnique({ where: { id: TEST_USER_ID } });
      expect(user!.chipBalance).toBe(40n);
      expect(user!.chipBalance).toBeGreaterThanOrEqual(0n);

      const ownerships = await prisma.cosmeticOwnership.count({ where: { userId: TEST_USER_ID } });
      expect(ownerships).toBe(1);
    } finally {
      // Order matters: ownerships FK-reference cosmetics with ON DELETE RESTRICT,
      // so the join rows must go before the catalog rows.
      await prisma.cosmeticOwnership.deleteMany({
        where: { cosmeticId: { in: ['test_item_a', 'test_item_b'] } },
      });
      await prisma.cosmetic.deleteMany({ where: { id: { in: ['test_item_a', 'test_item_b'] } } });
    }
  });
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

// Asserts no DB mutations occurred — balance unchanged, no ownerships, no
// PURCHASE ledger rows for the test user. Use after error-path tests that
// should never touch persistent state.
async function assertNoSideEffects() {
  const user = await prisma.user.findUnique({ where: { id: TEST_USER_ID } });
  expect(user!.chipBalance).toBe(TEST_USER_BALANCE);

  const ownerships = await prisma.cosmeticOwnership.count({ where: { userId: TEST_USER_ID } });
  expect(ownerships).toBe(0);

  const txns = await prisma.chipTransaction.count({
    where: { recipientId: TEST_USER_ID, type: 'PURCHASE' },
  });
  expect(txns).toBe(0);
}
