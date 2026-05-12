import { PrismaClient } from '@prisma/client';
import { roomManager } from './roomManager';
import { logger } from '../shared/utils';

const prisma = new PrismaClient();

const BOT_USERNAME     = 'StackBot';
const BOT_DISPLAY_NAME = 'Stack Bot';
const BOT_AVATAR_ID    = 'avatar_7'; // shark
const BOT_CHIPS        = BigInt(10_000_000);

export async function addBotToTable(tableId: string): Promise<void> {
  // ── Ensure bot user exists ────────────────────────────────────────────────
  let bot = await prisma.user.findUnique({ where: { username: BOT_USERNAME } });
  if (!bot) {
    bot = await prisma.user.create({
      data: {
        username:    BOT_USERNAME,
        displayName: BOT_DISPLAY_NAME,
        avatarId:    BOT_AVATAR_ID,
        chipBalance: BOT_CHIPS,
      },
    });
    logger.info(`Bot user created: ${bot.id}`);
  }

  // ── Check for existing active session ─────────────────────────────────────
  const existing = await prisma.tableSession.findUnique({
    where: { tableId_userId: { tableId, userId: bot.id } },
  });
  if (existing?.isActive) throw new Error('Bot already at this table');

  // ── Load table ────────────────────────────────────────────────────────────
  const table = await prisma.pokerTable.findUnique({ where: { id: tableId } });
  if (!table) throw new Error('Table not found');

  // ── Find next open seat index ─────────────────────────────────────────────
  const engine    = await roomManager.getOrCreate(tableId);
  const takenSeats = new Set(engine.getState().seats.map(s => s.seatIndex));
  let seatIndex = 0;
  while (takenSeats.has(seatIndex) && seatIndex < table.maxPlayers) seatIndex++;
  if (seatIndex >= table.maxPlayers) throw new Error('Table is full');

  const buyIn = Number(table.minBuyIn);

  // ── Create / reactivate TableSession ─────────────────────────────────────
  await prisma.tableSession.upsert({
    where:  { tableId_userId: { tableId, userId: bot.id } },
    create: {
      tableId,
      userId:       bot.id,
      seatIndex,
      buyInAmount:  BigInt(buyIn),
      currentStack: BigInt(buyIn),
      isActive:     true,
    },
    update: {
      seatIndex,
      buyInAmount:  BigInt(buyIn),
      currentStack: BigInt(buyIn),
      isActive:     true,
      leftAt:       null,
    },
  });

  // ── Add bot seat to engine ────────────────────────────────────────────────
  engine.addPlayer({
    seatIndex,
    userId:      bot.id,
    username:    BOT_USERNAME,
    displayName: BOT_DISPLAY_NAME,
    avatarId:    BOT_AVATAR_ID,
    stack:       buyIn,
    status:      'WAITING' as const,
    // Bots act instantly anyway — no need for a time bank.
    timeBank:    0,
    isConnected: true,
    isBot:       true,
  });

  logger.info(`Bot added to table ${tableId} at seat ${seatIndex}`);

  // ── Auto-start hand if ready ──────────────────────────────────────────────
  if (engine.canStartHand()) {
    setTimeout(() => engine.startHand(), 1500);
  }
}
