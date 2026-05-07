import 'dotenv/config';
import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import { createServer } from 'http';
import { Server as SocketServer } from 'socket.io';
import { PrismaClient } from '@prisma/client';
import { createClient } from 'redis';

import { authRouter }    from './auth/auth.routes';
import { lobbyRouter }   from './lobby/lobby.routes';
import { friendsRouter } from './friends/friends.routes';
import { usersRouter }   from './users/users.routes';
import { chipsRouter }   from './chips/chips.routes';
import { adminRouter }   from './game/admin.routes';
import { botRouter }     from './game/bot.routes';
import { apiRateLimit }  from './shared/middleware/rateLimit.middleware';
import { logger, sendError } from './shared/utils';
import { registerSocketHandlers } from './game/socket.handler';

// ─── App Setup ────────────────────────────────────────────────────────────────

const app = express();
const httpServer = createServer(app);

export const prisma = new PrismaClient({
  log: process.env.NODE_ENV === 'development' ? ['query', 'error'] : ['error'],
});

export const redis = createClient({ url: process.env.REDIS_URL || 'redis://localhost:6379' });

// ─── WebSocket Setup ──────────────────────────────────────────────────────────

export const io = new SocketServer(httpServer, {
  cors: {
    origin: process.env.ALLOWED_ORIGINS?.split(',') || ['http://localhost:3001'],
    credentials: true,
  },
  transports: ['websocket', 'polling'],
  pingTimeout: 30000,
  pingInterval: 10000,
});

// ─── Express Middleware ───────────────────────────────────────────────────────

app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      connectSrc: ["'self'", 'wss:'],
    },
  },
}));

app.use(cors({
  origin: process.env.ALLOWED_ORIGINS?.split(',') || ['http://localhost:3001'],
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
}));

app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));

// Trust first proxy (for correct IP in rate limiting)
app.set('trust proxy', 1);

// Global rate limit
app.use('/api', apiRateLimit);

// ─── Routes ───────────────────────────────────────────────────────────────────

app.use('/api/auth', authRouter);
app.use('/api/tables', lobbyRouter);
app.use('/api/friends', friendsRouter);
app.use('/api/users',   usersRouter);
app.use('/api/chips',   chipsRouter);
app.use('/api/admin',   adminRouter);
app.use('/api/tables',  botRouter);

// Health check
app.get('/health', (_req, res) => {
  res.json({
    status: 'ok',
    version: '1.0.0',
    timestamp: new Date().toISOString(),
  });
});

// 404 handler
app.use((_req, res) => {
  sendError(res, 'NOT_FOUND', 'Route not found', 404);
});

// Global error handler
app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  logger.error('Unhandled error:', err);
  sendError(res, 'SERVER_ERROR', 'Internal server error', 500);
});

// ─── Startup ──────────────────────────────────────────────────────────────────

// On boot, no sockets are connected yet — so any tableSession row marked
// `isActive = true` is by definition a ghost from the previous process.
// Return chips, mark sessions inactive, and close tables that emptied.
// Without this, the lobby keeps showing phantom seat counts (e.g. "3/5"
// when nobody is actually there) until each ghost user happens to log
// back in and explicitly leave.
async function reconcileOrphanedSessions(): Promise<void> {
  const orphans = await prisma.tableSession.findMany({
    where: { isActive: true },
    select: { id: true, userId: true, tableId: true, currentStack: true },
  });
  if (orphans.length === 0) {
    logger.info('Startup reconcile: no orphaned sessions');
    return;
  }

  // Group stacks by userId so each user gets one chip increment.
  const refundByUser = new Map<string, bigint>();
  for (const s of orphans) {
    refundByUser.set(s.userId, (refundByUser.get(s.userId) ?? 0n) + s.currentStack);
  }

  const affectedTableIds = Array.from(new Set(orphans.map(s => s.tableId)));
  const now = new Date();

  await prisma.$transaction([
    prisma.tableSession.updateMany({
      where: { id: { in: orphans.map(s => s.id) } },
      data: { isActive: false, leftAt: now },
    }),
    ...Array.from(refundByUser.entries()).map(([userId, amount]) =>
      prisma.user.update({
        where: { id: userId },
        data: { chipBalance: { increment: amount } },
      })
    ),
    ...orphans.map(s =>
      prisma.chipTransaction.create({
        data: {
          recipientId: s.userId,
          amount: s.currentStack,
          type: 'CASH_OUT',
          tableId: s.tableId,
          description: 'Auto cash-out (server restart reconcile)',
        },
      })
    ),
  ]);

  // Close tables that now have no active sessions.
  let closed = 0;
  for (const tableId of affectedTableIds) {
    const remaining = await prisma.tableSession.count({
      where: { tableId, isActive: true },
    });
    if (remaining === 0) {
      const table = await prisma.pokerTable.findUnique({
        where: { id: tableId },
        select: { status: true },
      });
      if (table && table.status !== 'CLOSED') {
        await prisma.pokerTable.update({
          where: { id: tableId },
          data: { status: 'CLOSED', closedAt: now },
        });
        closed += 1;
      }
    }
  }

  logger.info(
    `Startup reconcile: cleared ${orphans.length} orphaned sessions across ${affectedTableIds.length} tables, closed ${closed} empty tables`
  );
}

async function start() {
  try {
    // Connect to Redis
    await redis.connect();
    logger.info('Redis connected');

    // Test Prisma connection
    await prisma.$connect();
    logger.info('PostgreSQL connected');

    // Clean up sessions left behind by the previous process before any
    // sockets connect, so the lobby reflects reality from the first poll.
    await reconcileOrphanedSessions();

    // Register Socket.IO game handlers
    registerSocketHandlers(io);

    const PORT = parseInt(process.env.PORT || '3000');
    httpServer.listen(PORT, () => {
      logger.info(`StackPoker server running on port ${PORT}`);
      logger.info(`Environment: ${process.env.NODE_ENV}`);
    });

  } catch (err) {
    logger.error('Startup failed:', err);
    process.exit(1);
  }
}

// Graceful shutdown
process.on('SIGTERM', async () => {
  logger.info('SIGTERM received, shutting down gracefully...');
  await prisma.$disconnect();
  await redis.disconnect();
  process.exit(0);
});

start();

export default app;
