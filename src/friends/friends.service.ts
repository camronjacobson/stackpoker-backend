import { PrismaClient } from '@prisma/client';
import { serializeBigInt } from '../shared/utils';
import { Friend, SearchedUser } from '../lobby/lobby.types';
import { getEquippedForUsers } from '../cosmetics/cosmetics.service';

const prisma = new PrismaClient();

// ─── Get Friends List ─────────────────────────────────────────────────────────

export async function getFriends(userId: string): Promise<Friend[]> {
  const friendships = await prisma.friendship.findMany({
    where: {
      status: 'ACCEPTED',
      OR: [{ senderId: userId }, { receiverId: userId }],
    },
    include: {
      sender:   { select: { id: true, username: true, displayName: true, avatarId: true, chipBalance: true, lastSeenAt: true } },
      receiver: { select: { id: true, username: true, displayName: true, avatarId: true, chipBalance: true, lastSeenAt: true } },
    },
    orderBy: { updatedAt: 'desc' },
  });

  // Determine online status: last seen within 2 minutes
  const twoMinAgo = new Date(Date.now() - 2 * 60 * 1000);

  // Batch-fetch equipped cosmetics for every friend in one query — same
  // helper the seat-broadcast hydration uses, so the wire shape matches
  // exactly: { [category]: cosmeticId }. Users with no equipped items are
  // absent from the map; we coerce to `{}` so the iOS client always gets
  // a deterministic dict rather than `null`.
  const friendIds = friendships.map(f => (f.senderId === userId ? f.receiverId : f.senderId));
  const equippedByUser = await getEquippedForUsers(friendIds);

  return friendships.map(f => {
    const friend = f.senderId === userId ? f.receiver : f.sender;
    const isOnline = friend.lastSeenAt > twoMinAgo;
    return serializeBigInt({
      friendshipId: f.id,
      userId: friend.id,
      username: friend.username,
      displayName: friend.displayName,
      avatarId: friend.avatarId,
      chipBalance: friend.chipBalance.toString(),
      isOnline,
      equippedCosmetics: equippedByUser.get(friend.id) ?? {},
    }) as Friend;
  });
}

// ─── Get Pending Requests ─────────────────────────────────────────────────────

export async function getPendingRequests(userId: string) {
  const requests = await prisma.friendship.findMany({
    where: { receiverId: userId, status: 'PENDING' },
    include: {
      sender: { select: { id: true, username: true, displayName: true, avatarId: true } },
    },
    orderBy: { createdAt: 'desc' },
  });

  return requests.map(r => ({
    id: r.id,
    status: r.status,
    createdAt: r.createdAt,
    sender: r.sender,
  }));
}

// ─── Send Friend Request ──────────────────────────────────────────────────────

export async function sendFriendRequest(senderId: string, recipientId: string): Promise<void> {
  if (senderId === recipientId) {
    throw { code: 'INVALID_REQUEST', message: 'You cannot add yourself as a friend' };
  }

  const recipient = await prisma.user.findUnique({ where: { id: recipientId } });
  if (!recipient) throw { code: 'NOT_FOUND', message: 'User not found' };

  // Check for existing friendship
  const existing = await prisma.friendship.findFirst({
    where: {
      OR: [
        { senderId, receiverId: recipientId },
        { senderId: recipientId, receiverId: senderId },
      ],
    },
  });

  if (existing) {
    if (existing.status === 'ACCEPTED') throw { code: 'ALREADY_FRIENDS', message: 'Already friends' };
    if (existing.status === 'PENDING') throw { code: 'REQUEST_PENDING', message: 'Friend request already sent' };
    if (existing.status === 'BLOCKED') throw { code: 'BLOCKED', message: 'Unable to send request' };
  }

  await prisma.friendship.create({
    data: { senderId, receiverId: recipientId, status: 'PENDING' },
  });
}

// ─── Respond to Friend Request ────────────────────────────────────────────────

export async function respondToFriendRequest(
  userId: string,
  friendshipId: string,
  accept: boolean
): Promise<void> {
  const friendship = await prisma.friendship.findUnique({ where: { id: friendshipId } });

  if (!friendship) throw { code: 'NOT_FOUND', message: 'Friend request not found' };
  if (friendship.receiverId !== userId) throw { code: 'FORBIDDEN', message: 'Not your request' };
  if (friendship.status !== 'PENDING') throw { code: 'INVALID_STATUS', message: 'Request already handled' };

  await prisma.friendship.update({
    where: { id: friendshipId },
    data: { status: accept ? 'ACCEPTED' : 'BLOCKED' },
  });
}

// ─── Remove Friend ────────────────────────────────────────────────────────────

export async function removeFriend(userId: string, friendshipId: string): Promise<void> {
  const friendship = await prisma.friendship.findUnique({ where: { id: friendshipId } });

  if (!friendship) throw { code: 'NOT_FOUND', message: 'Friendship not found' };
  if (friendship.senderId !== userId && friendship.receiverId !== userId) {
    throw { code: 'FORBIDDEN', message: 'Not your friendship' };
  }

  await prisma.friendship.delete({ where: { id: friendshipId } });
}

// ─── Block User ───────────────────────────────────────────────────────────────

export async function blockUser(userId: string, targetId: string): Promise<void> {
  const existing = await prisma.friendship.findFirst({
    where: {
      OR: [
        { senderId: userId, receiverId: targetId },
        { senderId: targetId, receiverId: userId },
      ],
    },
  });

  if (existing) {
    await prisma.friendship.update({ where: { id: existing.id }, data: { status: 'BLOCKED' } });
  } else {
    await prisma.friendship.create({
      data: { senderId: userId, receiverId: targetId, status: 'BLOCKED' },
    });
  }
}

// ─── Search Users ─────────────────────────────────────────────────────────────

export async function searchUsers(requesterId: string, query: string): Promise<SearchedUser[]> {
  if (query.length < 2) return [];

  const users = await prisma.user.findMany({
    where: {
      AND: [
        { id: { not: requesterId } },
        { isBanned: false },
        {
          OR: [
            { username: { contains: query, mode: 'insensitive' } },
            { displayName: { contains: query, mode: 'insensitive' } },
          ],
        },
      ],
    },
    take: 20,
    select: {
      id: true,
      username: true,
      displayName: true,
      avatarId: true,
      chipBalance: true,
    },
  });

  // Get existing friendships
  const friendships = await prisma.friendship.findMany({
    where: {
      OR: [
        { senderId: requesterId, receiverId: { in: users.map(u => u.id) } },
        { senderId: { in: users.map(u => u.id) }, receiverId: requesterId },
      ],
    },
  });

  const friendshipMap = new Map(
    friendships.map(f => {
      const otherId = f.senderId === requesterId ? f.receiverId : f.senderId;
      return [otherId, { status: f.status, id: f.id }];
    })
  );

  return users.map(u => serializeBigInt({
    id: u.id,
    username: u.username,
    displayName: u.displayName,
    avatarId: u.avatarId,
    chipBalance: u.chipBalance.toString(),
    friendshipStatus: friendshipMap.get(u.id)?.status ?? 'NONE',
    friendshipId: friendshipMap.get(u.id)?.id,
  })) as SearchedUser[];
}
