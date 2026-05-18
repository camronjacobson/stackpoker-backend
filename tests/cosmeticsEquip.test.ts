// ─── Cosmetics equip — service integration tests ─────────────────────────────
//
// Validates equip / unequip / inventory service functions against the real
// dev DB. The actual route handlers are thin pass-throughs (validate input,
// call service, format response), so testing at the service layer catches
// every business-rule path. Express-validator behavior at the route is
// exercised by curl in the smoke step.

import { PrismaClient } from '@prisma/client';
import {
  equipCosmetic,
  unequipCosmetic,
  getUserInventory,
  getEquippedForUsers,
} from '../src/cosmetics/cosmetics.service';

const prisma = new PrismaClient();

const TEST_USER_ID    = '00000000-0000-0000-0000-0000000eee01';
const OTHER_USER_ID   = '00000000-0000-0000-0000-0000000eee02';
const TEST_USERNAME   = 'cosmetics_equip_test_user';
const OTHER_USERNAME  = 'cosmetics_equip_other_user';

// Two cardBack cosmetics so we can test "equip replaces previous equip in
// the same category", plus one tableFelt to verify CATEGORY_MISMATCH and
// that the equipped-map keys by category correctly.
const COSMETIC_BACK_A   = 'test_equip_cardback_a';
const COSMETIC_BACK_B   = 'test_equip_cardback_b';
const COSMETIC_FELT     = 'test_equip_felt';

beforeAll(async () => {
  await prisma.user.upsert({
    where:  { id: TEST_USER_ID },
    create: {
      id:          TEST_USER_ID,
      username:    `${TEST_USERNAME}_${Date.now()}`,
      displayName: 'Equip Test User',
      chipBalance: 1000n,
    },
    update: {},
  });
  await prisma.user.upsert({
    where:  { id: OTHER_USER_ID },
    create: {
      id:          OTHER_USER_ID,
      username:    `${OTHER_USERNAME}_${Date.now()}`,
      displayName: 'Other Equip Test User',
      chipBalance: 1000n,
    },
    update: {},
  });

  // Clean catalog rows in case a prior run left them behind.
  await prisma.cosmetic.deleteMany({
    where: { id: { in: [COSMETIC_BACK_A, COSMETIC_BACK_B, COSMETIC_FELT] } },
  });

  await prisma.cosmetic.createMany({
    data: [
      { id: COSMETIC_BACK_A, name: 'Back A', category: 'cardBack',  rarity: 'common', priceChips: 100n, unlockCondition: 'purchase' },
      { id: COSMETIC_BACK_B, name: 'Back B', category: 'cardBack',  rarity: 'common', priceChips: 100n, unlockCondition: 'purchase' },
      { id: COSMETIC_FELT,   name: 'Felt',   category: 'tableFelt', rarity: 'common', priceChips: 100n, unlockCondition: 'purchase' },
    ],
  });
});

afterAll(async () => {
  // Order: equipped + ownerships first (FK to cosmetics + users), then cosmetics, then users.
  await prisma.equippedCosmetic.deleteMany({ where: { userId: { in: [TEST_USER_ID, OTHER_USER_ID] } } });
  await prisma.cosmeticOwnership.deleteMany({ where: { userId: { in: [TEST_USER_ID, OTHER_USER_ID] } } });
  await prisma.cosmetic.deleteMany({
    where: { id: { in: [COSMETIC_BACK_A, COSMETIC_BACK_B, COSMETIC_FELT] } },
  });
  await prisma.user.deleteMany({ where: { id: { in: [TEST_USER_ID, OTHER_USER_ID] } } });
  await prisma.$disconnect();
});

// Reset per-test: wipe equip rows + ownerships for the two test users.
// Each test grants the ownerships it needs explicitly so the precondition is
// visible in the test body.
async function resetUserState() {
  await prisma.equippedCosmetic.deleteMany({ where: { userId: { in: [TEST_USER_ID, OTHER_USER_ID] } } });
  await prisma.cosmeticOwnership.deleteMany({ where: { userId: { in: [TEST_USER_ID, OTHER_USER_ID] } } });
}

beforeEach(resetUserState);

// Helper: grant ownership without going through the purchase flow (which
// would require a balance setup and ledger writes we don't care about here).
async function grant(userId: string, cosmeticId: string) {
  await prisma.cosmeticOwnership.create({ data: { userId, cosmeticId } });
}

// ─── equipCosmetic ───────────────────────────────────────────────────────────

describe('equipCosmetic — happy path', () => {
  test('owned cosmetic in matching category → row created, returns new state', async () => {
    await grant(TEST_USER_ID, COSMETIC_BACK_A);

    const result = await equipCosmetic(TEST_USER_ID, COSMETIC_BACK_A, 'cardBack');
    expect(result).toEqual({ category: 'cardBack', cosmeticId: COSMETIC_BACK_A });

    const row = await prisma.equippedCosmetic.findUnique({
      where: { userId_category: { userId: TEST_USER_ID, category: 'cardBack' } },
    });
    expect(row?.cosmeticId).toBe(COSMETIC_BACK_A);
  });

  test('equipping a second cosmetic in the same category replaces the first (upsert)', async () => {
    await grant(TEST_USER_ID, COSMETIC_BACK_A);
    await grant(TEST_USER_ID, COSMETIC_BACK_B);

    await equipCosmetic(TEST_USER_ID, COSMETIC_BACK_A, 'cardBack');
    const result = await equipCosmetic(TEST_USER_ID, COSMETIC_BACK_B, 'cardBack');
    expect(result.cosmeticId).toBe(COSMETIC_BACK_B);

    // Only one row exists for this slot — the unique constraint enforces it.
    const rows = await prisma.equippedCosmetic.findMany({
      where: { userId: TEST_USER_ID, category: 'cardBack' },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].cosmeticId).toBe(COSMETIC_BACK_B);
  });
});

describe('equipCosmetic — error paths', () => {
  test('COSMETIC_NOT_FOUND — unknown id → 404', async () => {
    await expect(equipCosmetic(TEST_USER_ID, 'nonexistent_cosmetic_xyz', 'cardBack'))
      .rejects.toMatchObject({ code: 'COSMETIC_NOT_FOUND', status: 404 });
  });

  test('CATEGORY_MISMATCH — cardBack cosmetic requested for tableFelt slot → 409', async () => {
    await grant(TEST_USER_ID, COSMETIC_BACK_A);
    await expect(equipCosmetic(TEST_USER_ID, COSMETIC_BACK_A, 'tableFelt'))
      .rejects.toMatchObject({ code: 'CATEGORY_MISMATCH', status: 409 });
  });

  test('NOT_OWNED — user has no ownership row → 403', async () => {
    // No grant() call — user does not own COSMETIC_BACK_A
    await expect(equipCosmetic(TEST_USER_ID, COSMETIC_BACK_A, 'cardBack'))
      .rejects.toMatchObject({ code: 'NOT_OWNED', status: 403 });
  });

  test('NOT_OWNED — other user owns it, this user does not → 403', async () => {
    await grant(OTHER_USER_ID, COSMETIC_BACK_A);
    await expect(equipCosmetic(TEST_USER_ID, COSMETIC_BACK_A, 'cardBack'))
      .rejects.toMatchObject({ code: 'NOT_OWNED', status: 403 });
  });
});

// ─── unequipCosmetic ─────────────────────────────────────────────────────────

describe('unequipCosmetic', () => {
  test('removes the equipped row when one exists', async () => {
    await grant(TEST_USER_ID, COSMETIC_BACK_A);
    await equipCosmetic(TEST_USER_ID, COSMETIC_BACK_A, 'cardBack');

    const result = await unequipCosmetic(TEST_USER_ID, 'cardBack');
    expect(result).toEqual({ category: 'cardBack', cosmeticId: null });

    const row = await prisma.equippedCosmetic.findUnique({
      where: { userId_category: { userId: TEST_USER_ID, category: 'cardBack' } },
    });
    expect(row).toBeNull();
  });

  test('idempotent — unequipping an empty slot succeeds without throwing', async () => {
    const result = await unequipCosmetic(TEST_USER_ID, 'cardBack');
    expect(result).toEqual({ category: 'cardBack', cosmeticId: null });
  });

  test('does not affect other users\' equips in the same category', async () => {
    await grant(OTHER_USER_ID, COSMETIC_BACK_A);
    await equipCosmetic(OTHER_USER_ID, COSMETIC_BACK_A, 'cardBack');

    await unequipCosmetic(TEST_USER_ID, 'cardBack');

    // Other user's equip is untouched.
    const otherRow = await prisma.equippedCosmetic.findUnique({
      where: { userId_category: { userId: OTHER_USER_ID, category: 'cardBack' } },
    });
    expect(otherRow?.cosmeticId).toBe(COSMETIC_BACK_A);
  });
});

// ─── getUserInventory ────────────────────────────────────────────────────────

describe('getUserInventory', () => {
  test('returns empty arrays for a user with no ownerships or equips', async () => {
    const inv = await getUserInventory(TEST_USER_ID);
    expect(inv).toEqual({ ownedIds: [], equipped: {} });
  });

  test('returns owned + equipped state correctly', async () => {
    await grant(TEST_USER_ID, COSMETIC_BACK_A);
    await grant(TEST_USER_ID, COSMETIC_BACK_B);
    await grant(TEST_USER_ID, COSMETIC_FELT);
    await equipCosmetic(TEST_USER_ID, COSMETIC_BACK_B, 'cardBack');
    await equipCosmetic(TEST_USER_ID, COSMETIC_FELT, 'tableFelt');

    const inv = await getUserInventory(TEST_USER_ID);

    expect(inv.ownedIds.sort()).toEqual(
      [COSMETIC_BACK_A, COSMETIC_BACK_B, COSMETIC_FELT].sort(),
    );
    expect(inv.equipped).toEqual({
      cardBack:  COSMETIC_BACK_B,
      tableFelt: COSMETIC_FELT,
    });
  });

  test('owning a cosmetic without equipping it shows in ownedIds but not in equipped', async () => {
    await grant(TEST_USER_ID, COSMETIC_BACK_A);

    const inv = await getUserInventory(TEST_USER_ID);
    expect(inv.ownedIds).toEqual([COSMETIC_BACK_A]);
    expect(inv.equipped).toEqual({});
  });
});

// ─── getEquippedForUsers (bulk lookup for seat broadcast) ────────────────────

describe('getEquippedForUsers', () => {
  test('returns empty map for empty userIds array (avoids unnecessary DB roundtrip)', async () => {
    const result = await getEquippedForUsers([]);
    expect(result.size).toBe(0);
  });

  test('returns map keyed by userId with per-category equipped cosmetics', async () => {
    await grant(TEST_USER_ID, COSMETIC_BACK_A);
    await grant(OTHER_USER_ID, COSMETIC_BACK_B);
    await grant(OTHER_USER_ID, COSMETIC_FELT);
    await equipCosmetic(TEST_USER_ID, COSMETIC_BACK_A, 'cardBack');
    await equipCosmetic(OTHER_USER_ID, COSMETIC_BACK_B, 'cardBack');
    await equipCosmetic(OTHER_USER_ID, COSMETIC_FELT, 'tableFelt');

    const result = await getEquippedForUsers([TEST_USER_ID, OTHER_USER_ID]);

    expect(result.get(TEST_USER_ID)).toEqual({ cardBack: COSMETIC_BACK_A });
    expect(result.get(OTHER_USER_ID)).toEqual({
      cardBack:  COSMETIC_BACK_B,
      tableFelt: COSMETIC_FELT,
    });
  });

  test('users with no equips are absent from the map (not present with empty object)', async () => {
    await grant(TEST_USER_ID, COSMETIC_BACK_A);
    await equipCosmetic(TEST_USER_ID, COSMETIC_BACK_A, 'cardBack');
    // OTHER_USER_ID has nothing equipped.

    const result = await getEquippedForUsers([TEST_USER_ID, OTHER_USER_ID]);
    expect(result.has(TEST_USER_ID)).toBe(true);
    expect(result.has(OTHER_USER_ID)).toBe(false);
  });
});
