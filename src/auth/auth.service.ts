import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { v4 as uuidv4 } from 'uuid';
import { PrismaClient } from '@prisma/client';
import appleSignin from 'apple-signin-auth';
import {
  RegisterRequest,
  LoginRequest,
  AppleAuthRequest,
  AuthTokens,
  TokenPayload,
} from '../shared/types';
import { logger, isValidUsername, isValidDisplayName, serializeBigInt } from '../shared/utils';

const prisma = new PrismaClient();
const BCRYPT_ROUNDS = 12;

// ─── Token Generation ─────────────────────────────────────────────────────────

function generateTokens(userId: string, username: string): AuthTokens {
  const payload: Omit<TokenPayload, 'iat' | 'exp'> = { sub: userId, username };

  const accessToken = jwt.sign(payload as object, process.env.JWT_ACCESS_SECRET!, {
    expiresIn: (process.env.JWT_ACCESS_EXPIRES_IN || '15m') as string,
  } as jwt.SignOptions);

  const refreshToken = jwt.sign(
    { ...payload, jti: uuidv4() } as object,
    process.env.JWT_REFRESH_SECRET!,
    { expiresIn: (process.env.JWT_REFRESH_EXPIRES_IN || '30d') as string } as jwt.SignOptions
  );

  return { accessToken, refreshToken, expiresIn: 15 * 60 };
}

// ─── Register ─────────────────────────────────────────────────────────────────

export async function register(data: RegisterRequest, deviceInfo?: { deviceId?: string; deviceName?: string; ip?: string }) {
  const { email, password, username, displayName, avatarId } = data;

  // Validate
  if (!isValidUsername(username)) {
    throw { code: 'INVALID_USERNAME', message: 'Username must be 3-20 characters, letters/numbers/underscore only' };
  }
  if (!isValidDisplayName(displayName)) {
    throw { code: 'INVALID_DISPLAY_NAME', message: 'Display name must be 2-30 characters' };
  }
  if (password.length < 8) {
    throw { code: 'WEAK_PASSWORD', message: 'Password must be at least 8 characters' };
  }

  // Check uniqueness
  const [existingEmail, existingUsername] = await Promise.all([
    prisma.user.findUnique({ where: { email } }),
    prisma.user.findUnique({ where: { username } }),
  ]);

  if (existingEmail) throw { code: 'EMAIL_TAKEN', message: 'Email already in use' };
  if (existingUsername) throw { code: 'USERNAME_TAKEN', message: 'Username already taken' };

  const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);

  // Create user + give signup bonus in a transaction
  const signupBonus = BigInt(process.env.SIGNUP_BONUS_CHIPS || '10000');

  const user = await prisma.$transaction(async (tx) => {
    const newUser = await tx.user.create({
      data: {
        email,
        passwordHash,
        username,
        displayName,
        avatarId,
        chipBalance: signupBonus,
      },
    });

    await tx.chipTransaction.create({
      data: {
        recipientId: newUser.id,
        amount: signupBonus,
        type: 'SIGNUP_BONUS',
        description: 'Welcome bonus chips!',
      },
    });

    return newUser;
  });

  const tokens = generateTokens(user.id, user.username);
  const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);

  await prisma.session.create({
    data: {
      userId: user.id,
      refreshToken: tokens.refreshToken,
      deviceId: deviceInfo?.deviceId,
      deviceName: deviceInfo?.deviceName,
      ipAddress: deviceInfo?.ip,
      expiresAt,
    },
  });

  logger.info(`New user registered: ${user.username} (${user.id})`);

  return {
    tokens,
    user: serializeBigInt({
      id: user.id,
      username: user.username,
      displayName: user.displayName,
      avatarId: user.avatarId,
      chipBalance: user.chipBalance,
      email: user.email,
      isAdmin: user.isAdmin,
      createdAt: user.createdAt,
    }),
  };
}

// ─── Login ────────────────────────────────────────────────────────────────────

export async function login(data: LoginRequest, deviceInfo?: { deviceId?: string; deviceName?: string; ip?: string }) {
  const { email, password } = data;

  const user = await prisma.user.findUnique({ where: { email } });

  if (!user) {
    throw { code: 'INVALID_CREDENTIALS', message: 'Invalid email or password' };
  }

  if (user.isBanned) {
    throw { code: 'ACCOUNT_BANNED', message: `Account suspended: ${user.banReason || 'Policy violation'}` };
  }

  const isValid = user.passwordHash ? await bcrypt.compare(password, user.passwordHash) : false;

  if (!isValid) {
    throw { code: 'INVALID_CREDENTIALS', message: 'Invalid email or password' };
  }

  // Update last seen
  await prisma.user.update({
    where: { id: user.id },
    data: { lastSeenAt: new Date() },
  });

  const tokens = generateTokens(user.id, user.username);
  const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);

  await prisma.session.create({
    data: {
      userId: user.id,
      refreshToken: tokens.refreshToken,
      deviceId: deviceInfo?.deviceId,
      deviceName: deviceInfo?.deviceName,
      ipAddress: deviceInfo?.ip,
      expiresAt,
    },
  });

  logger.info(`User logged in: ${user.username}`);

  return {
    tokens,
    user: serializeBigInt({
      id: user.id,
      username: user.username,
      displayName: user.displayName,
      avatarId: user.avatarId,
      chipBalance: user.chipBalance,
      email: user.email,
      isAdmin: user.isAdmin,
      createdAt: user.createdAt,
      lastSeenAt: user.lastSeenAt,
    }),
  };
}

// ─── Apple Sign In ────────────────────────────────────────────────────────────

export async function appleSignIn(data: AppleAuthRequest, deviceInfo?: { deviceId?: string; ip?: string }) {
  const { identityToken, authorizationCode, fullName, username, avatarId } = data;

  // Verify Apple identity token
  let appleData: { sub: string; email?: string };
  try {
    appleData = await appleSignin.verifyIdToken(identityToken, {
      audience: process.env.APPLE_CLIENT_ID!,
      ignoreExpiration: false,
    }) as { sub: string; email?: string };
  } catch (err) {
    throw { code: 'INVALID_APPLE_TOKEN', message: 'Apple authentication failed' };
  }

  const appleId = appleData.sub;
  const email = appleData.email;

  // Check if user exists
  let user = await prisma.user.findUnique({ where: { appleId } });

  if (!user) {
    // New Apple user — need username
    if (!username) {
      throw { code: 'USERNAME_REQUIRED', message: 'Please choose a username to complete signup', data: { email } };
    }

    if (!isValidUsername(username)) {
      throw { code: 'INVALID_USERNAME', message: 'Username must be 3-20 chars, letters/numbers/underscore' };
    }

    const existingUsername = await prisma.user.findUnique({ where: { username } });
    if (existingUsername) {
      throw { code: 'USERNAME_TAKEN', message: 'Username already taken' };
    }

    const displayName = fullName
      ? `${fullName.givenName || ''} ${fullName.familyName || ''}`.trim() || username
      : username;

    const signupBonus = BigInt(process.env.SIGNUP_BONUS_CHIPS || '10000');

    user = await prisma.$transaction(async (tx) => {
      const newUser = await tx.user.create({
        data: {
          appleId,
          email: email || undefined,
          username,
          displayName,
          avatarId: avatarId || 'avatar_1',
          chipBalance: signupBonus,
        },
      });

      await tx.chipTransaction.create({
        data: {
          recipientId: newUser.id,
          amount: signupBonus,
          type: 'SIGNUP_BONUS',
          description: 'Welcome bonus chips!',
        },
      });

      return newUser;
    });

    logger.info(`New Apple user registered: ${user.username}`);
  }

  if (user.isBanned) {
    throw { code: 'ACCOUNT_BANNED', message: `Account suspended: ${user.banReason || 'Policy violation'}` };
  }

  await prisma.user.update({
    where: { id: user.id },
    data: { lastSeenAt: new Date() },
  });

  const tokens = generateTokens(user.id, user.username);
  const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);

  await prisma.session.create({
    data: {
      userId: user.id,
      refreshToken: tokens.refreshToken,
      deviceId: deviceInfo?.deviceId,
      ipAddress: deviceInfo?.ip,
      expiresAt,
    },
  });

  return {
    tokens,
    user: serializeBigInt({
      id: user.id,
      username: user.username,
      displayName: user.displayName,
      avatarId: user.avatarId,
      chipBalance: user.chipBalance,
      email: user.email,
      isAdmin: user.isAdmin,
    }),
    isNewUser: !user.lastSeenAt,
  };
}

// ─── Refresh Token ────────────────────────────────────────────────────────────

export async function refreshTokens(refreshToken: string) {
  let payload: TokenPayload;

  try {
    payload = jwt.verify(refreshToken, process.env.JWT_REFRESH_SECRET!) as TokenPayload;
  } catch {
    throw { code: 'INVALID_REFRESH_TOKEN', message: 'Invalid or expired refresh token' };
  }

  // Check session exists and not revoked
  const session = await prisma.session.findUnique({ where: { refreshToken } });

  if (!session || session.revokedAt || session.expiresAt < new Date()) {
    throw { code: 'SESSION_EXPIRED', message: 'Session expired, please login again' };
  }

  const user = await prisma.user.findUnique({ where: { id: payload.sub } });

  if (!user || user.isBanned) {
    throw { code: 'ACCOUNT_UNAVAILABLE', message: 'Account not available' };
  }

  // Rotate refresh token (invalidate old one)
  const newTokens = generateTokens(user.id, user.username);
  const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);

  await prisma.$transaction([
    prisma.session.update({
      where: { id: session.id },
      data: { revokedAt: new Date() },
    }),
    prisma.session.create({
      data: {
        userId: user.id,
        refreshToken: newTokens.refreshToken,
        deviceId: session.deviceId,
        deviceName: session.deviceName,
        expiresAt,
      },
    }),
  ]);

  return { tokens: newTokens };
}

// ─── Logout ───────────────────────────────────────────────────────────────────

export async function logout(refreshToken: string): Promise<void> {
  await prisma.session.updateMany({
    where: { refreshToken, revokedAt: null },
    data: { revokedAt: new Date() },
  });
}

// ─── Check Username Availability ──────────────────────────────────────────────

export async function checkUsername(username: string): Promise<{ available: boolean; valid: boolean }> {
  const valid = isValidUsername(username);
  if (!valid) return { available: false, valid: false };

  const existing = await prisma.user.findUnique({ where: { username } });
  return { available: !existing, valid: true };
}

// ─── Get Profile ──────────────────────────────────────────────────────────────

export async function getProfile(userId: string) {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) throw { code: 'NOT_FOUND', message: 'User not found' };

  return serializeBigInt({
    id: user.id,
    username: user.username,
    displayName: user.displayName,
    avatarId: user.avatarId,
    avatarUrl: user.avatarUrl,
    chipBalance: user.chipBalance,
    totalWon: user.totalWon,
    totalLost: user.totalLost,
    handsPlayed: user.handsPlayed,
    gamesPlayed: user.gamesPlayed,
    email: user.email,
    isAdmin: user.isAdmin,
    createdAt: user.createdAt,
    lastSeenAt: user.lastSeenAt,
  });
}

// ─── Update profile (avatar, displayName) ──────────────────────────────────
// Partial update — only the fields present in the request are modified.

export async function updateProfile(
  userId: string,
  data: { avatarId?: string; displayName?: string },
) {
  const updates: { avatarId?: string; displayName?: string } = {};

  if (typeof data.avatarId === 'string' && data.avatarId.length > 0) {
    updates.avatarId = data.avatarId;
  }
  if (typeof data.displayName === 'string') {
    const name = data.displayName.trim();
    if (name.length < 2 || name.length > 30) {
      throw { code: 'INVALID_DISPLAY_NAME', message: 'Display name must be 2–30 characters' };
    }
    updates.displayName = name;
  }

  if (Object.keys(updates).length === 0) {
    throw { code: 'NO_UPDATES', message: 'No valid fields to update' };
  }

  await prisma.user.update({ where: { id: userId }, data: updates });
  return getProfile(userId);
}
