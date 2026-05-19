import { PrismaClient } from '@prisma/client';
import { roomManager } from '../game/roomManager';
import { serializeBigInt, logger } from '../shared/utils';
import { BOT_PROFILES, ensureBotUser } from './botService';

const prisma = new PrismaClient();

// ─── Verify admin or owner ────────────────────────────────────────────────────

async function assertTableOwner(requesterId: string, tableId: string): Promise<void> {
  const table = await prisma.pokerTable.findUnique({ where: { id: tableId } });
  if (!table) throw { code: 'NOT_FOUND', message: 'Table not found' };
  if (table.ownerId !== requesterId) {
    const user = await prisma.user.findUnique({ where: { id: requesterId } });
    if (!user?.isAdmin) throw { code: 'FORBIDDEN', message: 'Table owner or admin only' };
  }
}

// ─── Kick player from table ───────────────────────────────────────────────────

export async function kickPlayer(requesterId: string, tableId: string, targetUserId: string): Promise<void> {
  await assertTableOwner(requesterId, tableId);

  if (requesterId === targetUserId) throw { code: 'INVALID', message: 'Cannot kick yourself' };

  // Remove from game engine
  const engine = roomManager.get(tableId);
  if (engine) engine.removePlayer(targetUserId);

  // Cash out their stack and mark session inactive
  const session = await prisma.tableSession.findUnique({
    where: { tableId_userId: { tableId, userId: targetUserId } },
  });

  if (session?.isActive) {
    await prisma.$transaction([
      prisma.tableSession.update({
        where: { id: session.id },
        data: { isActive: false, leftAt: new Date() },
      }),
      prisma.user.update({
        where: { id: targetUserId },
        data: { chipBalance: { increment: session.currentStack } },
      }),
    ]);
  }

  logger.info(`Admin kick: ${targetUserId} removed from table ${tableId} by ${requesterId}`);
}

// ─── Ban player ───────────────────────────────────────────────────────────────

export async function banPlayer(
  requesterId: string,
  targetUserId: string,
  reason: string
): Promise<void> {
  const requester = await prisma.user.findUnique({ where: { id: requesterId } });
  if (!requester?.isAdmin) throw { code: 'FORBIDDEN', message: 'Admin only' };
  if (requesterId === targetUserId) throw { code: 'INVALID', message: 'Cannot ban yourself' };

  await prisma.user.update({
    where: { id: targetUserId },
    data: { isBanned: true, banReason: reason || 'Policy violation' },
  });

  // Revoke all active sessions
  await prisma.session.updateMany({
    where: { userId: targetUserId, revokedAt: null },
    data: { revokedAt: new Date() },
  });

  logger.info(`Admin ban: ${targetUserId} banned by ${requesterId} — reason: ${reason}`);
}

// ─── Unban player ─────────────────────────────────────────────────────────────

export async function unbanPlayer(requesterId: string, targetUserId: string): Promise<void> {
  const requester = await prisma.user.findUnique({ where: { id: requesterId } });
  if (!requester?.isAdmin) throw { code: 'FORBIDDEN', message: 'Admin only' };

  await prisma.user.update({
    where: { id: targetUserId },
    data: { isBanned: false, banReason: null },
  });

  logger.info(`Admin unban: ${targetUserId} by ${requesterId}`);
}

// ─── Reset table (restart engine, refund chips) ───────────────────────────────

export async function resetTable(requesterId: string, tableId: string): Promise<void> {
  await assertTableOwner(requesterId, tableId);

  // Destroy engine (will be recreated on next join)
  roomManager.destroy(tableId);

  // Return all seated players' stacks to their original buy-in amounts
  const sessions = await prisma.tableSession.findMany({
    where: { tableId, isActive: true },
    include: { user: true },
  });

  await prisma.$transaction(
    sessions.map(s =>
      prisma.tableSession.update({
        where: { id: s.id },
        data: { currentStack: s.buyInAmount },
      })
    )
  );

  // Update table status
  await prisma.pokerTable.update({
    where: { id: tableId },
    data: { status: 'WAITING', currentHandId: null },
  });

  logger.info(`Table ${tableId} reset by ${requesterId}`);
}

// ─── Grant chips (admin) ──────────────────────────────────────────────────────

export async function grantChips(
  requesterId: string,
  targetUserId: string,
  amount: number
): Promise<void> {
  const requester = await prisma.user.findUnique({ where: { id: requesterId } });
  if (!requester) throw { code: 'NOT_FOUND', message: 'Requester not found' };

  // PLAYTEST CARVE-OUT — revert before App Store submission.
  //
  // The iOS "Top up chips" dev button calls this endpoint with the caller's
  // OWN userId as the target. During playtesting we want everyone (not just
  // admins) to be able to top themselves up so testing sessions don't stall
  // on bankroll. Granting chips to *other* users remains admin-only — that
  // path can drain or pump arbitrary accounts and is not what the dev
  // button does.
  //
  // App Store launch checklist: remove this branch (or gate it behind an
  // env flag like PLAYTEST_MODE=true) before submission so non-admins
  // cannot mint their own balance in the production build.
  const isSelfGrant = requesterId === targetUserId;
  if (!requester.isAdmin && !isSelfGrant) {
    throw { code: 'FORBIDDEN', message: 'Admin only' };
  }
  if (amount <= 0 || amount > 10_000_000) throw { code: 'INVALID', message: 'Invalid amount' };

  await prisma.$transaction([
    prisma.user.update({
      where: { id: targetUserId },
      data: { chipBalance: { increment: BigInt(amount) } },
    }),
    prisma.chipTransaction.create({
      data: {
        recipientId: targetUserId,
        senderId: requesterId,
        amount: BigInt(amount),
        type: 'ADMIN_GRANT',
        description: `Admin chip grant from ${requester.username}`,
      },
    }),
  ]);

  logger.info(`Admin grant: ${amount} chips to ${targetUserId} by ${requesterId}`);
}

// ─── Seed test friends (debug helper) ─────────────────────────────────────────
//
// Mints all 8 BOT_PROFILES into mutual friendships with the caller and equips
// a different avatar frame on each so the caller can verify per-friend cosmetic
// rendering in the friends list without needing 8 real test accounts.
//
// Mapping (Alpha intentionally has no frame — control case for "nothing equipped"):
//   Alpha   → null              Echo    → diamond  (epic)
//   Bravo   → bronze   (common) Foxtrot → royal    (epic)
//   Charlie → gold     (rare)   Golf    → champion (legendary)
//   Delta   → platinum (rare)   Hotel   → mythic_inferno (mythic)
//
// Gated by isAdmin server-side. iOS gates the call site behind `#if DEBUG`
// so the button doesn't ship in App Store builds. Idempotent — re-running
// skips already-accepted friendships and just re-upserts the equipped frame.

const BOT_FRAME_ASSIGNMENTS: Record<string, string | null> = {
  StackBot_Alpha:   null,
  StackBot_Bravo:   'avatar_frame_bronze',
  StackBot_Charlie: 'avatar_frame_gold',
  StackBot_Delta:   'avatar_frame_platinum',
  StackBot_Echo:    'avatar_frame_diamond',
  StackBot_Foxtrot: 'avatar_frame_royal',
  StackBot_Golf:    'avatar_frame_champion',
  StackBot_Hotel:   'avatar_frame_mythic_inferno',
};

export interface SeedTestFriendsResult {
  seeded: Array<{ username: string; frameId: string | null; alreadyFriends: boolean }>;
  totalFriends: number;
}

export async function seedTestFriends(requesterId: string): Promise<SeedTestFriendsResult> {
  const requester = await prisma.user.findUnique({ where: { id: requesterId } });
  if (!requester) throw { code: 'NOT_FOUND', message: 'Requester not found' };
  if (!requester.isAdmin) throw { code: 'FORBIDDEN', message: 'Admin only' };

  const seeded: SeedTestFriendsResult['seeded'] = [];

  // Single transaction so a mid-loop failure (e.g. a dropped DB connection
  // between the 4th and 5th bot) doesn't leave the caller with a partial
  // test-friend set — re-runs would still work, but auditing "did the
  // seeding succeed?" gets murky. All-or-nothing keeps the mental model clean.
  await prisma.$transaction(async (tx) => {
    for (const profile of BOT_PROFILES) {
      // `ensureBotUser` uses the module-level prisma client, not the tx
      // client, so its writes commit independently. That's fine — bot User
      // rows are append-only, idempotent on username uniqueness, and reused
      // across many flows (table-add, seeding, future bot affordances).
      // Pulling them out of the transaction also means the bot row is
      // visible to the equip/friendship inserts inside the tx below.
      const bot = await ensureBotUser(profile);
      const frameId = BOT_FRAME_ASSIGNMENTS[profile.username] ?? null;

      // Bots don't have inventory records. Direct-write the equipped row
      // rather than grant + equip — purely test scaffolding.
      if (frameId) {
        await tx.equippedCosmetic.upsert({
          where: { userId_category: { userId: bot.id, category: 'avatarFrame' } },
          update: { cosmeticId: frameId },
          create: { userId: bot.id, category: 'avatarFrame', cosmeticId: frameId },
        });
      } else {
        // Alpha is the "no frame equipped" control case — actively clear any
        // stale row so re-runs after a mapping change reflect the new state.
        await tx.equippedCosmetic.deleteMany({
          where: { userId: bot.id, category: 'avatarFrame' },
        });
      }

      // Friendship rows are stored as a SINGLE directional row per pair —
      // `getFriends` resolves the other party via OR on senderId/receiverId.
      // Creating two rows would make the bot appear twice in the friends
      // list. Look up either direction; if any ACCEPTED row exists, skip.
      // If a PENDING row exists, upgrade it to ACCEPTED (covers the edge
      // case where someone previously sent a friend request to a bot and
      // it sat un-accepted — re-running the seed should heal that state).
      // BLOCKED rows are left alone; explicit user action shouldn't be
      // silently overridden by a debug button.
      const existing = await tx.friendship.findFirst({
        where: {
          OR: [
            { senderId: requesterId, receiverId: bot.id },
            { senderId: bot.id,      receiverId: requesterId },
          ],
        },
      });

      const alreadyFriends = existing?.status === 'ACCEPTED';
      if (!existing) {
        await tx.friendship.create({
          data: { senderId: requesterId, receiverId: bot.id, status: 'ACCEPTED' },
        });
      } else if (existing.status === 'PENDING') {
        await tx.friendship.update({
          where: { id: existing.id },
          data:  { status: 'ACCEPTED' },
        });
      }
      // existing.status === 'ACCEPTED' or 'BLOCKED' → no row change.

      seeded.push({ username: profile.username, frameId, alreadyFriends });
    }
  });

  // Re-count after the transaction so the response reflects the final state.
  const totalFriends = await prisma.friendship.count({
    where: {
      status: 'ACCEPTED',
      OR: [{ senderId: requesterId }, { receiverId: requesterId }],
    },
  });

  logger.info(`Admin seed-test-friends: ${seeded.length} bot friendships processed for ${requesterId}`);
  return { seeded, totalFriends };
}

// ─── Get table admin view ─────────────────────────────────────────────────────

export async function getTableAdminView(requesterId: string, tableId: string) {
  await assertTableOwner(requesterId, tableId);

  const table = await prisma.pokerTable.findUnique({
    where: { id: tableId },
    include: {
      sessions: {
        where: { isActive: true },
        include: { user: { select: { id: true, username: true, displayName: true, avatarId: true, chipBalance: true, isBanned: true } } },
      },
      hands: { orderBy: { createdAt: 'desc' }, take: 10 },
    },
  });

  if (!table) throw { code: 'NOT_FOUND', message: 'Table not found' };

  const engine = roomManager.get(tableId);
  const gameState = engine ? engine.buildClientView(requesterId) : null;

  return serializeBigInt({ table, gameState });
}
