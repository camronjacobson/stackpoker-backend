import { PrismaClient } from '@prisma/client';
import { serializeBigInt, logger } from '../shared/utils';

const prisma = new PrismaClient();

const DAILY_BONUS      = BigInt(process.env.DAILY_BONUS_CHIPS   ?? '1000');
const LOW_CHIP_BONUS   = BigInt(500);
const LOW_CHIP_THRESHOLD = BigInt(200);

// ─── Get balance ─────────────────────────────────────────────────────────────

export async function getBalance(userId: string) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { chipBalance: true, username: true },
  });
  if (!user) throw { code: 'NOT_FOUND', message: 'User not found' };
  return { chipBalance: user.chipBalance.toString() };
}

// ─── Daily bonus ─────────────────────────────────────────────────────────────

export async function claimDailyBonus(userId: string) {
  // Check if already claimed today
  const today  = new Date();
  today.setHours(0, 0, 0, 0);

  const recentBonus = await prisma.chipTransaction.findFirst({
    where: {
      recipientId: userId,
      type: 'DAILY_BONUS',
      createdAt: { gte: today },
    },
  });

  if (recentBonus) {
    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);
    const hoursLeft = Math.ceil((tomorrow.getTime() - Date.now()) / 3_600_000);
    throw { code: 'ALREADY_CLAIMED', message: `Come back in ${hoursLeft}h for your next bonus` };
  }

  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) throw { code: 'NOT_FOUND', message: 'User not found' };

  // Low-chip rescue: give extra if nearly broke
  const bonus = user.chipBalance < LOW_CHIP_THRESHOLD
    ? DAILY_BONUS + LOW_CHIP_BONUS
    : DAILY_BONUS;

  await prisma.$transaction([
    prisma.user.update({
      where: { id: userId },
      data: { chipBalance: { increment: bonus } },
    }),
    prisma.chipTransaction.create({
      data: {
        recipientId: userId,
        amount: bonus,
        type: 'DAILY_BONUS',
        description: user.chipBalance < LOW_CHIP_THRESHOLD
          ? 'Daily bonus + low chip rescue!'
          : 'Daily login bonus',
      },
    }),
  ]);

  logger.info(`Daily bonus claimed: ${userId} received ${bonus}`);
  return { bonusAmount: bonus.toString(), message: 'Chips added to your balance!' };
}

// ─── Transfer chips ───────────────────────────────────────────────────────────

export async function transferChips(
  senderId: string,
  recipientId: string,
  amount: number,
  note?: string
) {
  if (senderId === recipientId) throw { code: 'INVALID', message: 'Cannot transfer to yourself' };
  if (amount < 100) throw { code: 'INVALID', message: 'Minimum transfer is 100 chips' };
  if (amount > 1_000_000) throw { code: 'INVALID', message: 'Maximum single transfer is 1,000,000 chips' };

  const [sender, recipient] = await Promise.all([
    prisma.user.findUnique({ where: { id: senderId } }),
    prisma.user.findUnique({ where: { id: recipientId } }),
  ]);

  if (!sender)    throw { code: 'NOT_FOUND', message: 'Sender not found' };
  if (!recipient) throw { code: 'NOT_FOUND', message: 'Recipient not found' };
  if (recipient.isBanned) throw { code: 'FORBIDDEN', message: 'Cannot transfer to banned user' };
  if (sender.chipBalance < BigInt(amount)) {
    throw { code: 'INSUFFICIENT_CHIPS', message: 'Not enough chips' };
  }

  await prisma.$transaction([
    prisma.user.update({
      where: { id: senderId },
      data: { chipBalance: { decrement: BigInt(amount) } },
    }),
    prisma.user.update({
      where: { id: recipientId },
      data: { chipBalance: { increment: BigInt(amount) } },
    }),
    prisma.chipTransaction.create({
      data: {
        senderId,
        recipientId,
        amount: BigInt(amount),
        type: 'TRANSFER_SENT',
        description: note?.slice(0, 100) || `Transfer to ${recipient.username}`,
      },
    }),
  ]);

  logger.info(`Chip transfer: ${senderId} -> ${recipientId}, amount: ${amount}`);
  return { transferred: amount, recipient: recipient.username };
}

// ─── Chip history ─────────────────────────────────────────────────────────────

export async function getHistory(userId: string, page = 1, limit = 20) {
  const skip = (page - 1) * limit;

  const [transactions, total] = await Promise.all([
    prisma.chipTransaction.findMany({
      where: { OR: [{ senderId: userId }, { recipientId: userId }] },
      orderBy: { createdAt: 'desc' },
      skip,
      take: limit,
      include: {
        sender:    { select: { username: true, avatarId: true } },
        recipient: { select: { username: true, avatarId: true } },
      },
    }),
    prisma.chipTransaction.count({
      where: { OR: [{ senderId: userId }, { recipientId: userId }] },
    }),
  ]);

  return serializeBigInt({
    transactions: transactions.map(t => ({
      id:          t.id,
      type:        t.type,
      amount:      t.amount.toString(),
      description: t.description,
      createdAt:   t.createdAt,
      isCredit:    t.recipientId === userId,
      sender:      t.sender,
      recipient:   t.recipient,
    })),
    total,
    page,
    totalPages: Math.ceil(total / limit),
  });
}
