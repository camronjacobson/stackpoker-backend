import { PrismaClient } from '@prisma/client';
import { redis } from '../index';
import { serializeBigInt, logger } from '../shared/utils';
import {
  CreateTableRequest,
  JoinTableRequest,
  TableDetail,
  TableListItem,
} from './lobby.types';

const prisma = new PrismaClient();

// Redis key for online presence
const onlineKey = (userId: string) => `online:${userId}`;
const tablePlayersKey = (tableId: string) => `table_players:${tableId}`;

// ─── Create Table ─────────────────────────────────────────────────────────────

export async function createTable(ownerId: string, data: CreateTableRequest): Promise<TableDetail> {
  const { name, maxPlayers, smallBlind, bigBlind, minBuyIn, maxBuyIn, isPrivate, clubId, gameType } = data;

  // Validate blinds
  if (bigBlind !== smallBlind * 2) {
    throw { code: 'INVALID_BLINDS', message: 'Big blind must be exactly 2x the small blind' };
  }
  if (minBuyIn < bigBlind * 10) {
    throw { code: 'INVALID_BUYIN', message: 'Min buy-in must be at least 10x the big blind' };
  }
  if (maxBuyIn < minBuyIn) {
    throw { code: 'INVALID_BUYIN', message: 'Max buy-in must be >= min buy-in' };
  }
  if (maxPlayers < 2 || maxPlayers > 9) {
    throw { code: 'INVALID_PLAYERS', message: 'Table must allow 2–9 players' };
  }

  // If clubId provided, verify membership
  if (clubId) {
    const member = await prisma.clubMember.findUnique({
      where: { clubId_userId: { clubId, userId: ownerId } },
    });
    if (!member) throw { code: 'NOT_CLUB_MEMBER', message: 'You are not a member of this club' };
  }

  // NOTE: The "one active table per owner" limit has been removed. Users can
  // now create multiple tables freely. If this needs to come back, gate it
  // behind a config flag rather than an unconditional block.

  const table = await prisma.pokerTable.create({
    data: {
      name: name.trim(),
      ownerId,
      clubId: clubId || null,
      maxPlayers,
      smallBlind: BigInt(smallBlind),
      bigBlind: BigInt(bigBlind),
      minBuyIn: BigInt(minBuyIn),
      maxBuyIn: BigInt(maxBuyIn),
      isPrivate,
      gameType: gameType || 'TEXAS_HOLDEM',
      status: 'WAITING',
    },
    include: {
      owner: { select: { id: true, username: true, displayName: true, avatarId: true } },
      sessions: {
        where: { isActive: true },
        include: { user: { select: { id: true, username: true, displayName: true, avatarId: true } } },
      },
      club: { select: { name: true } },
    },
  });

  logger.info(`Table created: "${table.name}" (${table.id}) by ${ownerId}`);
  return serializeBigInt(formatTableDetail(table)) as TableDetail;
}

// ─── Get Table Detail ─────────────────────────────────────────────────────────

export async function getTableDetail(tableId: string, requestingUserId?: string): Promise<TableDetail> {
  const table = await prisma.pokerTable.findUnique({
    where: { id: tableId },
    include: {
      owner: { select: { id: true, username: true, displayName: true, avatarId: true } },
      sessions: {
        where: { isActive: true },
        orderBy: { seatIndex: 'asc' },
        include: { user: { select: { id: true, username: true, displayName: true, avatarId: true } } },
      },
      club: { select: { name: true } },
    },
  });

  if (!table) throw { code: 'NOT_FOUND', message: 'Table not found' };

  // Private table — only show to members/owner
  if (table.isPrivate && requestingUserId) {
    const isMember = table.sessions.some(s => s.userId === requestingUserId);
    const isOwner = table.ownerId === requestingUserId;
    if (!isMember && !isOwner) {
      throw { code: 'FORBIDDEN', message: 'This is a private table' };
    }
  }

  return serializeBigInt(formatTableDetail(table)) as TableDetail;
}

// ─── List Tables ──────────────────────────────────────────────────────────────

export async function listTables(filters: {
  status?: string;
  clubId?: string;
  page?: number;
  limit?: number;
}): Promise<{ tables: TableListItem[]; total: number }> {
  const { status = 'WAITING', clubId, page = 1, limit = 20 } = filters;
  const skip = (page - 1) * limit;

  const where = {
    isPrivate: false,
    status: status as any,
    ...(clubId ? { clubId } : {}),
  };

  const [tables, total] = await Promise.all([
    prisma.pokerTable.findMany({
      where,
      skip,
      take: limit,
      orderBy: { createdAt: 'desc' },
      include: {
        owner: { select: { username: true, avatarId: true } },
        sessions: { where: { isActive: true }, select: { id: true } },
        club: { select: { name: true } },
      },
    }),
    prisma.pokerTable.count({ where }),
  ]);

  return {
    tables: tables.map(t => serializeBigInt({
      id: t.id,
      name: t.name,
      joinCode: t.joinCode,
      status: t.status,
      maxPlayers: t.maxPlayers,
      currentPlayers: t.sessions.length,
      smallBlind: t.smallBlind.toString(),
      bigBlind: t.bigBlind.toString(),
      minBuyIn: t.minBuyIn.toString(),
      maxBuyIn: t.maxBuyIn.toString(),
      isPrivate: t.isPrivate,
      ownerUsername: t.owner.username,
      ownerAvatarId: t.owner.avatarId,
      clubId: t.clubId,
      clubName: t.club?.name,
      gameType: (t as any).gameType ?? 'TEXAS_HOLDEM',
      createdAt: t.createdAt.toISOString(),
    })) as unknown as TableListItem[],
    total,
  };
}

// ─── Join Table by Code ───────────────────────────────────────────────────────

export async function joinTableByCode(
  userId: string,
  joinCode: string,
  data: JoinTableRequest
): Promise<TableDetail> {
  const table = await prisma.pokerTable.findUnique({
    where: { joinCode },
    include: {
      sessions: { where: { isActive: true } },
      owner: { select: { id: true, username: true, displayName: true, avatarId: true } },
    },
  });

  if (!table) throw { code: 'INVALID_CODE', message: 'No table found with that code' };
  if (table.status === 'CLOSED') throw { code: 'TABLE_CLOSED', message: 'This table is closed' };

  // Returning user with an active session bypasses the IN_PROGRESS gate — they
  // already have a seat and chips committed. The downstream joinTable() also
  // detects this and short-circuits to a no-op rejoin, but we need to skip the
  // IN_PROGRESS throw here too so the rejoin actually reaches that code path.
  const isRejoin = table.sessions.some(s => s.userId === userId);
  if (table.status === 'IN_PROGRESS' && !isRejoin) {
    throw { code: 'GAME_IN_PROGRESS', message: 'A game is already in progress' };
  }

  return joinTable(userId, table.id, data);
}

// ─── Join Table by ID ─────────────────────────────────────────────────────────

export async function joinTable(
  userId: string,
  tableId: string,
  data: JoinTableRequest
): Promise<TableDetail> {
  const { buyInAmount, seatIndex } = data;

  const table = await prisma.pokerTable.findUnique({
    where: { id: tableId },
    include: { sessions: { where: { isActive: true } } },
  });

  if (!table) throw { code: 'NOT_FOUND', message: 'Table not found' };
  if (table.status === 'CLOSED') throw { code: 'TABLE_CLOSED', message: 'This table is closed' };

  // Idempotent rejoin: if the user already has an ACTIVE session at this table,
  // treat the call as a graceful rejoin instead of failing with ALREADY_SEATED.
  // This covers the "killed the app mid-hand, reopened, hit Join Game" flow
  // where the in-memory `lastTable` was lost and the lobby UI doesn't know to
  // route through `rejoinTable()`. We don't re-charge chips or create a new
  // session — we just hand back the current detail so the iOS layer can
  // navigate into the game where `join_table` over the websocket reconciles.
  const existingSession = table.sessions.find(s => s.userId === userId);
  if (existingSession) {
    return getTableDetail(tableId, userId);
  }

  // Validate buy-in
  if (buyInAmount < Number(table.minBuyIn)) {
    throw { code: 'INVALID_BUYIN', message: `Minimum buy-in is ${table.minBuyIn}` };
  }
  if (buyInAmount > Number(table.maxBuyIn)) {
    throw { code: 'INVALID_BUYIN', message: `Maximum buy-in is ${table.maxBuyIn}` };
  }

  // Check table isn't full
  if (table.sessions.length >= table.maxPlayers) {
    throw { code: 'TABLE_FULL', message: 'This table is full' };
  }

  // Determine seat
  const takenSeats = new Set(table.sessions.map(s => s.seatIndex));
  let seat = seatIndex;
  if (seat === undefined || takenSeats.has(seat)) {
    // Auto-assign first available seat
    for (let i = 0; i < table.maxPlayers; i++) {
      if (!takenSeats.has(i)) { seat = i; break; }
    }
  }
  if (seat === undefined) throw { code: 'TABLE_FULL', message: 'No seats available' };

  // Deduct chips in a transaction
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) throw { code: 'NOT_FOUND', message: 'User not found' };

  if (user.chipBalance < BigInt(buyInAmount)) {
    throw { code: 'INSUFFICIENT_CHIPS', message: 'Not enough chips for this buy-in' };
  }

  await prisma.$transaction([
    prisma.user.update({
      where: { id: userId },
      data: { chipBalance: { decrement: BigInt(buyInAmount) } },
    }),
    prisma.tableSession.create({
      data: {
        tableId,
        userId,
        seatIndex: seat,
        buyInAmount: BigInt(buyInAmount),
        currentStack: BigInt(buyInAmount),
        isActive: true,
      },
    }),
    prisma.chipTransaction.create({
      data: {
        recipientId: userId,
        amount: BigInt(-buyInAmount),
        type: 'BUY_IN',
        tableId,
        description: `Buy-in to table "${table.name}"`,
      },
    }),
  ]);

  logger.info(`User ${userId} joined table ${tableId} with ${buyInAmount} chips at seat ${seat}`);
  return getTableDetail(tableId, userId);
}

// ─── Leave Table ──────────────────────────────────────────────────────────────

export async function leaveTable(userId: string, tableId: string): Promise<{ chipsReturned: string }> {
  const session = await prisma.tableSession.findUnique({
    where: { tableId_userId: { tableId, userId } },
  });

  if (!session || !session.isActive) {
    throw { code: 'NOT_AT_TABLE', message: 'You are not at this table' };
  }

  const table = await prisma.pokerTable.findUnique({ where: { id: tableId } });
  if (table?.status === 'IN_PROGRESS') {
    throw { code: 'GAME_IN_PROGRESS', message: 'Cannot leave during a hand. Wait for the hand to end.' };
  }

  const stack = session.currentStack;

  // If chips were already credited via softLeaveCashOut, just close the
  // session — re-incrementing chipBalance here would double-pay. The
  // CASH_OUT transaction was already written at soft-leave time, so the
  // user's transaction log already shows the cash-out.
  const ops: any[] = [
    prisma.tableSession.update({
      where: { id: session.id },
      data: { isActive: false, leftAt: new Date(), chipsReturned: false },
    }),
  ];
  if (!session.chipsReturned) {
    ops.push(
      prisma.user.update({
        where: { id: userId },
        data: { chipBalance: { increment: stack } },
      }),
      prisma.chipTransaction.create({
        data: {
          recipientId: userId,
          amount: stack,
          type: 'CASH_OUT',
          tableId,
          description: `Cash out from table`,
        },
      }),
    );
  }
  await prisma.$transaction(ops);

  // Close table if owner left and no other players
  const remaining = await prisma.tableSession.count({
    where: { tableId, isActive: true },
  });
  if (remaining === 0) {
    await prisma.pokerTable.update({
      where: { id: tableId },
      data: { status: 'CLOSED', closedAt: new Date() },
    });
  }

  const returned = session.chipsReturned ? 0n : stack;
  logger.info(`User ${userId} left table ${tableId}, returned ${returned} chips (already-credited=${session.chipsReturned})`);
  return { chipsReturned: returned.toString() };
}

// ─── Soft-leave cash-out (Option C) ──────────────────────────────────────────
// Called from the leave_table socket handler when a user taps Leave Table
// with chips still on the seat. Returns chips to wallet immediately so the
// lobby balance reflects the cash-out without waiting for the grace window,
// while keeping the DB session row alive (chipsReturned=true,
// disconnectedAt=now) so a Rejoin within grace can re-debit the wallet and
// reseat the user at the same stack. If the user doesn't come back, the
// sweeper calls leaveTable above which sees chipsReturned=true and skips
// the credit so chips are never paid twice.
export async function softLeaveCashOut(userId: string, tableId: string): Promise<{ chipsReturned: string }> {
  const session = await prisma.tableSession.findUnique({
    where: { tableId_userId: { tableId, userId } },
  });
  if (!session || !session.isActive) {
    throw { code: 'NOT_AT_TABLE', message: 'You are not at this table' };
  }
  // Already cashed-out and waiting for rejoin — just refresh the timer.
  if (session.chipsReturned) {
    await prisma.tableSession.update({
      where: { id: session.id },
      data: { disconnectedAt: new Date() },
    });
    return { chipsReturned: '0' };
  }
  const table = await prisma.pokerTable.findUnique({ where: { id: tableId } });
  if (table?.status === 'IN_PROGRESS') {
    throw { code: 'GAME_IN_PROGRESS', message: 'Cannot leave during a hand. Wait for the hand to end.' };
  }

  const stack = session.currentStack;
  await prisma.$transaction([
    prisma.tableSession.update({
      where: { id: session.id },
      data: { chipsReturned: true, disconnectedAt: new Date() },
    }),
    prisma.user.update({
      where: { id: userId },
      data: { chipBalance: { increment: stack } },
    }),
    prisma.chipTransaction.create({
      data: {
        recipientId: userId,
        amount: stack,
        type: 'CASH_OUT',
        tableId,
        description: `Cash out (rejoin pending)`,
      },
    }),
  ]);

  logger.info(`User ${userId} soft-left table ${tableId}, returned ${stack} chips (seat held for rejoin)`);
  return { chipsReturned: stack.toString() };
}

// ─── Rejoin re-debit (Option C) ──────────────────────────────────────────────
// Called from join_table when the user reconnects to a seat that was
// soft-left (chipsReturned=true). Re-debits the wallet and clears the
// soft-leave flags so the session is back to a normal active state with the
// engine. Throws INSUFFICIENT_CHIPS if the user spent the cashed-out chips
// elsewhere in the meantime.
export async function rejoinRedebit(userId: string, tableId: string): Promise<void> {
  const session = await prisma.tableSession.findUnique({
    where: { tableId_userId: { tableId, userId } },
  });
  if (!session || !session.isActive || !session.chipsReturned) return;

  const user = await prisma.user.findUnique({ where: { id: userId } });
  const stack = session.currentStack;
  if (!user || user.chipBalance < stack) {
    throw {
      code: 'INSUFFICIENT_CHIPS',
      message: `Not enough chips to reseat. Need ${stack.toString()} but have ${(user?.chipBalance ?? 0n).toString()}.`,
    };
  }

  await prisma.$transaction([
    prisma.tableSession.update({
      where: { id: session.id },
      data: { chipsReturned: false, disconnectedAt: null },
    }),
    prisma.user.update({
      where: { id: userId },
      data: { chipBalance: { decrement: stack } },
    }),
    prisma.chipTransaction.create({
      data: {
        // Match the existing buy-in convention: recipient=user, negative
        // amount denotes chips leaving the wallet to the table.
        recipientId: userId,
        amount: -stack,
        type: 'BUY_IN',
        tableId,
        description: `Rejoin reseat`,
      },
    }),
  ]);

  logger.info(`User ${userId} rejoined table ${tableId}, re-debited ${stack} chips`);
}

// ─── Top Up Chips (mid-table rebuy) ───────────────────────────────────────────
// Lets a seated player add chips to their stack. Two execution paths share
// the same validation here:
//
//   • `mode === 'apply'` (between hands): the chips credit the seat's
//     `currentStack` immediately, and the route layer calls `engine.setStack`
//     so the live broadcast picks up the new value. Original flow.
//
//   • `mode === 'queue'` (mid-hand): the chips are debited from the user's
//     bankroll *now* (locks the funds, prevents over-spending) but the
//     seat's `currentStack` in the DB stays untouched. The route layer
//     calls `engine.queueTopUp`, which parks the amount on the seat as
//     `pendingTopUp` and emits a state push so iOS can render a small
//     "+N pending" badge. The engine drains the queue into `seat.stack`
//     at the end of the current hand (see `applyPendingTopUps`), and the
//     next persist pass (roomManager.persistHandResult) syncs the DB
//     stack back from the engine.
//
// The mode-selection lives in the route — it has the engine handle and
// can read its phase. Service stays DB-only.

export type TopUpMode = 'apply' | 'queue';

export async function topUpChips(
  userId: string,
  tableId: string,
  amount: number,
  mode: TopUpMode = 'apply'
): Promise<{ newStack: string; addedAmount: string; pending: boolean }> {
  if (!Number.isInteger(amount) || amount <= 0) {
    throw { code: 'INVALID_AMOUNT', message: 'Top-up amount must be a positive integer' };
  }

  const session = await prisma.tableSession.findUnique({
    where: { tableId_userId: { tableId, userId } },
  });
  if (!session || !session.isActive) {
    throw { code: 'NOT_AT_TABLE', message: 'You are not seated at this table' };
  }

  const table = await prisma.pokerTable.findUnique({ where: { id: tableId } });
  if (!table) throw { code: 'NOT_FOUND', message: 'Table not found' };
  if (table.status === 'CLOSED') {
    throw { code: 'TABLE_CLOSED', message: 'This table is closed' };
  }

  // Max-buyin check uses the *projected* total — current stack plus the
  // amount being added. The queue path doesn't write the new stack to DB,
  // but the cap still has to hold to keep cash-game rules honest (a player
  // shouldn't be able to "queue" their way past maxBuyIn even if the hand
  // hasn't applied it yet).
  const projectedStack = session.currentStack + BigInt(amount);
  if (projectedStack > table.maxBuyIn) {
    throw {
      code: 'EXCEEDS_MAX_BUYIN',
      message: `Stack cannot exceed table max buy-in of ${table.maxBuyIn}`,
    };
  }

  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) throw { code: 'NOT_FOUND', message: 'User not found' };
  if (user.chipBalance < BigInt(amount)) {
    throw { code: 'INSUFFICIENT_CHIPS', message: 'Not enough chips for this top-up' };
  }

  // Common DB writes: debit user, record transaction. The session stack
  // update is the discriminator — only the 'apply' path writes it now.
  const writes: any[] = [
    prisma.user.update({
      where: { id: userId },
      data: { chipBalance: { decrement: BigInt(amount) } },
    }),
    prisma.chipTransaction.create({
      data: {
        recipientId: userId,
        amount:      BigInt(-amount),
        type:        'BUY_IN',
        tableId,
        description: mode === 'queue'
          ? `Pending top-up at table "${table.name}" (applies at hand end)`
          : `Top-up at table "${table.name}"`,
      },
    }),
  ];
  if (mode === 'apply') {
    writes.splice(1, 0, prisma.tableSession.update({
      where: { id: session.id },
      data: { currentStack: projectedStack },
    }));
  }
  await prisma.$transaction(writes);

  logger.info(
    `User ${userId} ${mode === 'queue' ? 'queued mid-hand' : 'topped up'} ${amount} chips ` +
    `at table ${tableId} (projected stack ${projectedStack})`,
  );

  return {
    // For 'queue', newStack is the projected post-apply value so the iOS
    // client can show a clean "after" preview even before the hand ends.
    newStack:    projectedStack.toString(),
    addedAmount: String(amount),
    pending:     mode === 'queue',
  };
}

// ─── Send Table Invite ────────────────────────────────────────────────────────

export async function sendTableInvite(
  senderId: string,
  tableId: string,
  recipientId: string
): Promise<void> {
  const [table, recipient, friendship] = await Promise.all([
    prisma.pokerTable.findUnique({ where: { id: tableId } }),
    prisma.user.findUnique({ where: { id: recipientId } }),
    prisma.friendship.findFirst({
      where: {
        OR: [
          { senderId, receiverId: recipientId, status: 'ACCEPTED' },
          { senderId: recipientId, receiverId: senderId, status: 'ACCEPTED' },
        ],
      },
    }),
  ]);

  if (!table) throw { code: 'NOT_FOUND', message: 'Table not found' };
  if (!recipient) throw { code: 'NOT_FOUND', message: 'User not found' };
  if (!friendship) throw { code: 'NOT_FRIENDS', message: 'You can only invite friends' };

  // Check for existing pending invite
  const existing = await prisma.tableInvite.findFirst({
    where: { tableId, senderId, recipientId, status: 'PENDING' },
  });
  if (existing) throw { code: 'INVITE_EXISTS', message: 'Invite already sent' };

  await prisma.tableInvite.create({
    data: {
      tableId,
      senderId,
      recipientId,
      expiresAt: new Date(Date.now() + 5 * 60 * 1000), // 5 minutes
    },
  });
}

// ─── Get Pending Invites ──────────────────────────────────────────────────────

export async function getPendingInvites(userId: string) {
  const invites = await prisma.tableInvite.findMany({
    where: {
      recipientId: userId,
      status: 'PENDING',
      expiresAt: { gt: new Date() },
    },
    include: {
      table: {
        select: {
          id: true, name: true, joinCode: true,
          smallBlind: true, bigBlind: true, maxPlayers: true,
          sessions: { where: { isActive: true }, select: { id: true } },
        },
      },
      sender: { select: { id: true, username: true, displayName: true, avatarId: true } },
    },
    orderBy: { createdAt: 'desc' },
  });

  return serializeBigInt(invites.map(inv => ({
    id: inv.id,
    status: inv.status,
    expiresAt: inv.expiresAt,
    createdAt: inv.createdAt,
    table: {
      id: inv.table.id,
      name: inv.table.name,
      joinCode: inv.table.joinCode,
      smallBlind: inv.table.smallBlind.toString(),
      bigBlind: inv.table.bigBlind.toString(),
      currentPlayers: inv.table.sessions.length,
      maxPlayers: inv.table.maxPlayers,
    },
    sender: inv.sender,
  })));
}

// ─── Respond to Invite ────────────────────────────────────────────────────────

export async function respondToInvite(
  userId: string,
  inviteId: string,
  accept: boolean
): Promise<{ joinCode?: string }> {
  const invite = await prisma.tableInvite.findUnique({
    where: { id: inviteId },
    include: { table: true },
  });

  if (!invite) throw { code: 'NOT_FOUND', message: 'Invite not found' };
  if (invite.recipientId !== userId) throw { code: 'FORBIDDEN', message: 'Not your invite' };
  if (invite.status !== 'PENDING') throw { code: 'INVITE_EXPIRED', message: 'Invite already responded to' };
  if (invite.expiresAt < new Date()) {
    await prisma.tableInvite.update({ where: { id: inviteId }, data: { status: 'EXPIRED' } });
    throw { code: 'INVITE_EXPIRED', message: 'Invite has expired' };
  }

  await prisma.tableInvite.update({
    where: { id: inviteId },
    data: { status: accept ? 'ACCEPTED' : 'DECLINED' },
  });

  return accept ? { joinCode: invite.table.joinCode } : {};
}

// ─── Close Table (owner only) ─────────────────────────────────────────────────

export async function closeTable(ownerId: string, tableId: string): Promise<void> {
  const table = await prisma.pokerTable.findUnique({
    where: { id: tableId },
    include: { sessions: { where: { isActive: true } } },
  });

  if (!table) throw { code: 'NOT_FOUND', message: 'Table not found' };
  if (table.ownerId !== ownerId) throw { code: 'FORBIDDEN', message: 'Only the table owner can close it' };
  if (table.status === 'CLOSED') throw { code: 'ALREADY_CLOSED', message: 'Table is already closed' };
  if (table.status === 'IN_PROGRESS') throw { code: 'GAME_IN_PROGRESS', message: 'Cannot close table during a hand' };

  // Return chips to all seated players
  await prisma.$transaction([
    ...table.sessions.map(session =>
      prisma.user.update({
        where: { id: session.userId },
        data: { chipBalance: { increment: session.currentStack } },
      })
    ),
    ...table.sessions.map(session =>
      prisma.tableSession.update({
        where: { id: session.id },
        data: { isActive: false, leftAt: new Date() },
      })
    ),
    prisma.pokerTable.update({
      where: { id: tableId },
      data: { status: 'CLOSED', closedAt: new Date() },
    }),
  ]);
}

// ─── Format Helper ────────────────────────────────────────────────────────────

function formatTableDetail(table: any): any {
  return {
    id: table.id,
    name: table.name,
    joinCode: table.joinCode,
    status: table.status,
    maxPlayers: table.maxPlayers,
    currentPlayers: table.sessions?.length ?? 0,
    smallBlind: table.smallBlind.toString(),
    bigBlind: table.bigBlind.toString(),
    minBuyIn: table.minBuyIn.toString(),
    maxBuyIn: table.maxBuyIn.toString(),
    isPrivate: table.isPrivate,
    gameType: table.gameType ?? 'TEXAS_HOLDEM',
    clubId: table.clubId,
    clubName: table.club?.name,
    owner: table.owner,
    players: (table.sessions ?? []).map((s: any) => ({
      userId: s.userId,
      username: s.user?.username,
      displayName: s.user?.displayName,
      avatarId: s.user?.avatarId,
      seatIndex: s.seatIndex,
      stack: s.currentStack.toString(),
      isActive: s.isActive,
      joinedAt: s.joinedAt,
    })),
    createdAt: table.createdAt,
  };
}
