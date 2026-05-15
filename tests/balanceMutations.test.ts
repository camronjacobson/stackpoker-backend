// ─── Per-endpoint newBalance assertions ──────────────────────────────────────
//
// One assertion per chip-mutating REST endpoint that the iOS HUD relies on:
// the returned `newBalance` must equal the post-mutation `User.chipBalance`
// committed by the same service call. Computed inside the transaction by the
// service implementation; we compare against the DB read after the call so a
// regression (e.g. removing the re-read step) shows up immediately.
//
// Pattern matches tests/cosmeticsPurchase.test.ts — real Prisma against the
// dev DB, fixtures created in beforeAll, reset in beforeEach.

import { PrismaClient } from '@prisma/client';
import * as chipsService from '../src/chips/chips.service';
import * as lobbyService from '../src/lobby/lobby.service';
import { forceCloseIdleTable } from '../src/game/socket.handler';

const prisma = new PrismaClient();

const SENDER_ID    = '00000000-0000-0000-0000-0000000ba1a1';
const RECIPIENT_ID = '00000000-0000-0000-0000-0000000ba1a2';
const START_BALANCE = 10_000n;

let testTableId: string | null = null;

beforeAll(async () => {
  await prisma.user.upsert({
    where:  { id: SENDER_ID },
    create: {
      id: SENDER_ID,
      username: `bal_sender_${Date.now()}`,
      displayName: 'Bal Sender',
      chipBalance: START_BALANCE,
    },
    update: { chipBalance: START_BALANCE },
  });
  await prisma.user.upsert({
    where:  { id: RECIPIENT_ID },
    create: {
      id: RECIPIENT_ID,
      username: `bal_recipient_${Date.now()}`,
      displayName: 'Bal Recipient',
      chipBalance: START_BALANCE,
    },
    update: { chipBalance: START_BALANCE },
  });

  const table = await prisma.pokerTable.create({
    data: {
      name: 'BalanceTestTable',
      ownerId: SENDER_ID,
      maxPlayers: 6,
      smallBlind: 5n, bigBlind: 10n,
      minBuyIn: 100n, maxBuyIn: 5000n,
      isPrivate: true,
      gameType: 'TEXAS_HOLDEM',
      status: 'WAITING',
    },
  });
  testTableId = table.id;
});

afterAll(async () => {
  if (testTableId) {
    await prisma.tableSession.deleteMany({ where: { tableId: testTableId } });
    await prisma.chipTransaction.deleteMany({ where: { tableId: testTableId } });
    await prisma.pokerTable.deleteMany({ where: { id: testTableId } });
  }
  await prisma.chipTransaction.deleteMany({
    where: { OR: [{ recipientId: SENDER_ID }, { recipientId: RECIPIENT_ID }, { senderId: SENDER_ID }] },
  });
  await prisma.user.deleteMany({ where: { id: { in: [SENDER_ID, RECIPIENT_ID] } } });
  await prisma.$disconnect();
});

async function resetBalances() {
  // Wipe any sessions/transactions from the prior test so each test starts
  // with the user not-seated and at the known starting balance.
  if (testTableId) {
    await prisma.tableSession.deleteMany({ where: { tableId: testTableId } });
    await prisma.chipTransaction.deleteMany({ where: { tableId: testTableId } });
    // The leaveTable test closes the table when the last seat leaves;
    // re-open it so subsequent tests can seat users again.
    await prisma.pokerTable.update({
      where: { id: testTableId },
      data: { status: 'WAITING', closedAt: null },
    });
  }
  await prisma.chipTransaction.deleteMany({
    where: { OR: [{ recipientId: SENDER_ID }, { senderId: SENDER_ID }] },
  });
  await prisma.user.update({ where: { id: SENDER_ID },    data: { chipBalance: START_BALANCE } });
  await prisma.user.update({ where: { id: RECIPIENT_ID }, data: { chipBalance: START_BALANCE } });
}

beforeEach(resetBalances);

// ─── Daily bonus ─────────────────────────────────────────────────────────────

describe('claimDailyBonus — newBalance', () => {
  test('newBalance equals post-credit DB balance', async () => {
    const result = await chipsService.claimDailyBonus(SENDER_ID);

    const after = await prisma.user.findUnique({ where: { id: SENDER_ID }, select: { chipBalance: true } });
    expect(result.newBalance).toBe(after!.chipBalance.toString());
    // Sanity: balance actually went up by bonusAmount.
    expect(BigInt(result.newBalance)).toBe(START_BALANCE + BigInt(result.bonusAmount));
  });
});

// ─── Transfer ────────────────────────────────────────────────────────────────

describe('transferChips — newBalance', () => {
  test('newBalance equals post-debit sender balance (not recipient)', async () => {
    const result = await chipsService.transferChips(SENDER_ID, RECIPIENT_ID, 1000);

    const senderAfter    = await prisma.user.findUnique({ where: { id: SENDER_ID },    select: { chipBalance: true } });
    const recipientAfter = await prisma.user.findUnique({ where: { id: RECIPIENT_ID }, select: { chipBalance: true } });

    expect(result.newBalance).toBe(senderAfter!.chipBalance.toString());
    expect(result.newBalance).not.toBe(recipientAfter!.chipBalance.toString());
    // Sanity: sender debited, recipient credited.
    expect(senderAfter!.chipBalance).toBe(START_BALANCE - 1000n);
    expect(recipientAfter!.chipBalance).toBe(START_BALANCE + 1000n);
  });
});

// ─── Join table ──────────────────────────────────────────────────────────────

describe('joinTable — newBalance', () => {
  test('newBalance equals post-buyin sender balance', async () => {
    const result = await lobbyService.joinTable(SENDER_ID, testTableId!, { buyInAmount: 4000 });

    const after = await prisma.user.findUnique({ where: { id: SENDER_ID }, select: { chipBalance: true } });
    expect(result.newBalance).toBe(after!.chipBalance.toString());
    expect(after!.chipBalance).toBe(START_BALANCE - 4000n);
  });
});

// ─── Top up ──────────────────────────────────────────────────────────────────

describe('topUpChips — newBalance', () => {
  test('newBalance equals post-debit sender balance (apply mode)', async () => {
    await lobbyService.joinTable(SENDER_ID, testTableId!, { buyInAmount: 1000 });
    const result = await lobbyService.topUpChips(SENDER_ID, testTableId!, 500, 'apply');

    const after = await prisma.user.findUnique({ where: { id: SENDER_ID }, select: { chipBalance: true } });
    expect(result.newBalance).toBe(after!.chipBalance.toString());
    expect(after!.chipBalance).toBe(START_BALANCE - 1000n - 500n);
  });
});

// ─── Leave table ─────────────────────────────────────────────────────────────

describe('leaveTable — newBalance', () => {
  test('newBalance equals post-credit sender balance', async () => {
    await lobbyService.joinTable(SENDER_ID, testTableId!, { buyInAmount: 2000 });
    const result = await lobbyService.leaveTable(SENDER_ID, testTableId!);

    const after = await prisma.user.findUnique({ where: { id: SENDER_ID }, select: { chipBalance: true } });
    expect(result.newBalance).toBe(after!.chipBalance.toString());
    // Buy-in (2000) was returned in full since no hands played.
    expect(after!.chipBalance).toBe(START_BALANCE);
    expect(result.chipsReturned).toBe('2000');
  });
});

// ─── softLeaveCashOut (socket-path) ───────────────────────────────────────────
// Triggered by `leave_table` socket event. Returns chips to wallet immediately
// while keeping the session row alive for a potential rejoin within grace.
// The newBalance return is what the handler feeds into your_chips_updated.

describe('softLeaveCashOut — newBalance', () => {
  test('newBalance equals post-credit DB balance after first soft-leave', async () => {
    await lobbyService.joinTable(SENDER_ID, testTableId!, { buyInAmount: 3000 });
    const result = await lobbyService.softLeaveCashOut(SENDER_ID, testTableId!);

    const after = await prisma.user.findUnique({ where: { id: SENDER_ID }, select: { chipBalance: true } });
    expect(result.newBalance).toBe(after!.chipBalance.toString());
    expect(result.chipsReturned).toBe('3000');
    // Buy-in fully refunded — wallet back at START.
    expect(after!.chipBalance).toBe(START_BALANCE);
  });

  test('idempotent call reports current balance and 0 chips returned', async () => {
    await lobbyService.joinTable(SENDER_ID, testTableId!, { buyInAmount: 2500 });
    await lobbyService.softLeaveCashOut(SENDER_ID, testTableId!);
    // Second call hits the chipsReturned-already-true branch — no further
    // credit, but the function must still report current balance so the
    // socket emit can refresh a stale HUD.
    const result = await lobbyService.softLeaveCashOut(SENDER_ID, testTableId!);

    const after = await prisma.user.findUnique({ where: { id: SENDER_ID }, select: { chipBalance: true } });
    expect(result.chipsReturned).toBe('0');
    expect(result.newBalance).toBe(after!.chipBalance.toString());
    expect(after!.chipBalance).toBe(START_BALANCE);
  });
});

// ─── rejoinRedebit (socket-path) ──────────────────────────────────────────────
// Triggered by `join_table` socket event after a soft-leave. Re-debits the
// wallet and clears the chipsReturned flag.

describe('rejoinRedebit — newBalance', () => {
  test('newBalance equals post-debit DB balance, didDebit=true', async () => {
    await lobbyService.joinTable(SENDER_ID, testTableId!, { buyInAmount: 2000 });
    await lobbyService.softLeaveCashOut(SENDER_ID, testTableId!);
    const result = await lobbyService.rejoinRedebit(SENDER_ID, testTableId!);

    const after = await prisma.user.findUnique({ where: { id: SENDER_ID }, select: { chipBalance: true } });
    expect(result.didDebit).toBe(true);
    expect(result.newBalance).toBe(after!.chipBalance.toString());
    // Soft-left → 10000, rejoin re-debits the 2000 stack → 8000.
    expect(after!.chipBalance).toBe(START_BALANCE - 2000n);
  });

  test('no-op branch reports current balance and didDebit=false', async () => {
    // User is seated but has NOT soft-left → rejoinRedebit is a no-op.
    await lobbyService.joinTable(SENDER_ID, testTableId!, { buyInAmount: 1500 });
    const result = await lobbyService.rejoinRedebit(SENDER_ID, testTableId!);

    const after = await prisma.user.findUnique({ where: { id: SENDER_ID }, select: { chipBalance: true } });
    expect(result.didDebit).toBe(false);
    expect(result.newBalance).toBe(after!.chipBalance.toString());
    // Balance is still post-buyin (8500), unchanged by the no-op rejoin.
    expect(after!.chipBalance).toBe(START_BALANCE - 1500n);
  });
});

// ─── forceCloseIdleTable (socket-path) ────────────────────────────────────────
// Triggered by the idle-table sweeper when a table has had no human activity
// for TABLE_IDLE_MS. Refunds every active session's currentStack and emits
// your_chips_updated to each user's room. Tested with a mock SocketServer so
// we can assert the emit payload.

describe('forceCloseIdleTable — your_chips_updated emit', () => {
  test('emits per-user newBalance matching DB after credit', async () => {
    // Seat both users at an isolated table so we can verify per-user emits
    // without interference from the shared testTableId fixture.
    const idleTable = await prisma.pokerTable.create({
      data: {
        name: 'IdleSweepTestTable',
        ownerId: SENDER_ID,
        maxPlayers: 6,
        smallBlind: 5n, bigBlind: 10n,
        minBuyIn: 100n, maxBuyIn: 5000n,
        isPrivate: true,
        gameType: 'TEXAS_HOLDEM',
        status: 'WAITING',
      },
    });
    try {
      await lobbyService.joinTable(SENDER_ID,    idleTable.id, { buyInAmount: 1000 });
      await lobbyService.joinTable(RECIPIENT_ID, idleTable.id, { buyInAmount: 1500 });

      // Capture every io.to(room).emit(event, payload) call.
      const emits: Array<{ room: string; event: string; payload: any }> = [];
      const mockIo: any = {
        to(room: string) {
          return { emit(event: string, payload: any) { emits.push({ room, event, payload }); } };
        },
      };

      await forceCloseIdleTable(mockIo, idleTable.id);

      // One your_chips_updated per active session.
      const chipsEmits = emits.filter(e => e.event === 'your_chips_updated');
      expect(chipsEmits).toHaveLength(2);

      // Each emit's newBalance must match the user's post-credit DB balance.
      const senderAfter    = await prisma.user.findUnique({ where: { id: SENDER_ID },    select: { chipBalance: true } });
      const recipientAfter = await prisma.user.findUnique({ where: { id: RECIPIENT_ID }, select: { chipBalance: true } });

      const senderEmit    = chipsEmits.find(e => e.room === `user:${SENDER_ID}`);
      const recipientEmit = chipsEmits.find(e => e.room === `user:${RECIPIENT_ID}`);

      expect(senderEmit).toBeDefined();
      expect(recipientEmit).toBeDefined();
      expect(senderEmit!.payload.data.newBalance).toBe(senderAfter!.chipBalance.toString());
      expect(recipientEmit!.payload.data.newBalance).toBe(recipientAfter!.chipBalance.toString());
      expect(senderEmit!.payload.data.reason).toBe('idle_table_closed');

      // Sanity: both stacks refunded → balances back at START.
      expect(senderAfter!.chipBalance).toBe(START_BALANCE);
      expect(recipientAfter!.chipBalance).toBe(START_BALANCE);

      // table_closed emit is also expected (existing behavior).
      const tableClosedEmits = emits.filter(e => e.event === 'table_closed');
      expect(tableClosedEmits).toHaveLength(1);
    } finally {
      await prisma.tableSession.deleteMany({ where: { tableId: idleTable.id } });
      await prisma.chipTransaction.deleteMany({ where: { tableId: idleTable.id } });
      await prisma.pokerTable.delete({ where: { id: idleTable.id } });
    }
  });
});
