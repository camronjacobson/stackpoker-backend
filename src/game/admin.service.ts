import { PrismaClient } from '@prisma/client';
import { roomManager } from '../game/roomManager';
import { serializeBigInt, logger } from '../shared/utils';

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
  if (!requester?.isAdmin) throw { code: 'FORBIDDEN', message: 'Admin only' };
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
