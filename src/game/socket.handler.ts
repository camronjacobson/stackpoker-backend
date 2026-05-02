import { Server as SocketServer, Socket } from 'socket.io';
import jwt from 'jsonwebtoken';
import { TokenPayload } from '../shared/types';
import { ServerGameState } from './gameState.types';
import { roomManager } from './roomManager';
import { logger } from '../shared/utils';
import { PrismaClient } from '@prisma/client';
import { generateBotReply, botTypingDelayMs } from './botChat';
import * as lobbyService from '../lobby/lobby.service';

const prisma = new PrismaClient();

// Disconnect grace period — when a socket drops we don't immediately free
// the seat; we wait this long for a reconnect (network blip, app
// foreground/background, etc). If the user doesn't come back, we run the
// real `leaveTable` flow to return chips and free the lobby slot. Without
// this, sessions accumulate forever and the lobby shows ghost players.
const DISCONNECT_GRACE_MS = 90_000;
const sessionCleanupTimers = new Map<string, NodeJS.Timeout>();
const cleanupKey = (tableId: string, userId: string) => `${tableId}:${userId}`;

async function autoLeave(userId: string, tableId: string) {
  try {
    await lobbyService.leaveTable(userId, tableId);
    logger.info(`Auto-leave: freed ${userId} from ${tableId} after grace period`);
  } catch (err: any) {
    // GAME_IN_PROGRESS / NOT_AT_TABLE are expected non-errors — the user
    // either left already or is mid-hand. Anything else is real.
    if (err?.code !== 'GAME_IN_PROGRESS' && err?.code !== 'NOT_AT_TABLE') {
      logger.error('autoLeave failed:', err);
    }
  }
}

// ── Idle-table sweeper ─────────────────────────────────────────────────────
// Close any WAITING table that has had no human socket connected for
// TABLE_IDLE_MS. Catches bot-only tables that humans abandoned, and any
// tables whose sessions are inactive but were never closed. IN_PROGRESS
// tables are skipped — we never close mid-hand.
const TABLE_IDLE_MS    = 90_000;
const SWEEP_INTERVAL_MS = 15_000;
const lastHumanActivityAt = new Map<string, number>();

function markTableActive(tableId: string) {
  lastHumanActivityAt.set(tableId, Date.now());
}

async function forceCloseIdleTable(io: SocketServer, tableId: string): Promise<void> {
  const sessions = await prisma.tableSession.findMany({
    where: { tableId, isActive: true },
  });

  const now = new Date();
  const ops: any[] = [
    prisma.pokerTable.update({
      where: { id: tableId },
      data: { status: 'CLOSED', closedAt: now },
    }),
  ];
  if (sessions.length > 0) {
    ops.push(
      prisma.tableSession.updateMany({
        where: { tableId, isActive: true },
        data: { isActive: false, leftAt: now },
      })
    );
    for (const s of sessions) {
      ops.push(
        prisma.user.update({
          where: { id: s.userId },
          data: { chipBalance: { increment: s.currentStack } },
        })
      );
      ops.push(
        prisma.chipTransaction.create({
          data: {
            recipientId:  s.userId,
            amount:       s.currentStack,
            type:         'CASH_OUT',
            tableId,
            description:  'Auto cash-out (idle table)',
          },
        })
      );
    }
  }
  await prisma.$transaction(ops);

  // Drop the in-memory engine and any pending grace timers for this table.
  roomManager.destroy(tableId);
  lastHumanActivityAt.delete(tableId);
  for (const [key, timer] of Array.from(sessionCleanupTimers.entries())) {
    if (key.startsWith(`${tableId}:`)) {
      clearTimeout(timer);
      sessionCleanupTimers.delete(key);
    }
  }

  // Notify any sockets still in the room (shouldn't be any, but be safe).
  io.to(tableRoom(tableId)).emit('table_closed', {
    event: 'table_closed',
    data: { tableId, reason: 'idle' },
    ts: Date.now(),
  });
}

async function sweepIdleTables(io: SocketServer): Promise<void> {
  // Pull every non-closed table; combine with in-memory activity map.
  // This catches tables that the current process never saw a human on.
  const tables = await prisma.pokerTable.findMany({
    where: { status: { in: ['WAITING', 'IN_PROGRESS'] as any } },
    select: { id: true, status: true, name: true },
  });
  const now = Date.now();

  for (const t of tables) {
    try {
      // Never close mid-hand. Refresh timestamp so we wait a fresh 90s
      // after the hand ends.
      if (t.status === 'IN_PROGRESS') { lastHumanActivityAt.set(t.id, now); continue; }

      const sockets = await io.in(tableRoom(t.id)).fetchSockets();
      if (sockets.length > 0) {
        // Real humans are connected — refresh and skip.
        lastHumanActivityAt.set(t.id, now);
        continue;
      }

      // No humans connected. If we've never seen this table active, treat
      // first sighting as "now" so it still gets a 90s grace before close.
      const last = lastHumanActivityAt.get(t.id);
      if (last === undefined) { lastHumanActivityAt.set(t.id, now); continue; }
      if (now - last < TABLE_IDLE_MS) continue;

      logger.info(`Idle sweep: closing "${t.name}" (${t.id}) — idle ${Math.round((now - last) / 1000)}s`);
      await forceCloseIdleTable(io, t.id);
    } catch (err) {
      logger.error(`Idle sweep error for table ${t.id}:`, err);
    }
  }
}

function socketAuth(socket: Socket, next: (err?: Error) => void): void {
  // Accept token from Socket.IO auth object (SDK clients) or URL query param (native WebSocket clients)
  const token = (socket.handshake.auth.token || socket.handshake.query.token) as string;
  if (!token) { next(new Error('AUTH_REQUIRED')); return; }
  try {
    const payload = jwt.verify(token, process.env.JWT_ACCESS_SECRET!) as TokenPayload;
    (socket as any).userId   = payload.sub;
    (socket as any).username = payload.username;
    next();
  } catch { next(new Error('INVALID_TOKEN')); }
}

function uid(socket: Socket)  { return (socket as any).userId  as string; }
function uname(socket: Socket){ return (socket as any).username as string; }
function tableRoom(tableId: string) { return `table:${tableId}`; }
function userRoom(userId: string)   { return `user:${userId}`; }

function emit<T>(socket: Socket, event: string, data: T) {
  socket.emit(event, { event, data, ts: Date.now() });
}

async function broadcastGameState(io: SocketServer, tableId: string) {
  const sockets = await io.in(tableRoom(tableId)).fetchSockets();
  for (const sock of sockets) {
    const forUser = (sock as any).userId as string;
    const engine  = roomManager.get(tableId);
    if (engine) {
      sock.emit('game_state', { event: 'game_state', data: engine.buildClientView(forUser), ts: Date.now() });
    }
  }
}

export function registerSocketHandlers(io: SocketServer): void {
  io.use(socketAuth);

  // Periodic sweep that closes any WAITING table with no connected human
  // for TABLE_IDLE_MS. Runs forever for the lifetime of the process.
  setInterval(() => { void sweepIdleTables(io); }, SWEEP_INTERVAL_MS);

  roomManager.setBroadcastFn((tableId, _state) => broadcastGameState(io, tableId));
  roomManager.setHandEndFn((tableId, state) => {
    io.to(tableRoom(tableId)).emit('hand_ended', {
      event: 'hand_ended',
      data: { winners: state.winners, handNumber: state.handNumber },
      ts: Date.now(),
    });
  });

  io.on('connection', (socket: Socket) => {
    const userId   = uid(socket);
    const username = uname(socket);
    logger.info(`WS connected: ${username}`);
    socket.join(userRoom(userId));

    socket.on('join_table', async (payload: { tableId: string }) => {
      try {
        const { tableId } = payload;

        // Reconnecting before the grace period elapsed — cancel pending
        // auto-leave so the user keeps their seat and chips.
        const pending = sessionCleanupTimers.get(cleanupKey(tableId, userId));
        if (pending) {
          clearTimeout(pending);
          sessionCleanupTimers.delete(cleanupKey(tableId, userId));
        }

        const session = await prisma.tableSession.findUnique({
          where: { tableId_userId: { tableId, userId } },
          include: { user: { select: { username: true, displayName: true, avatarId: true } } },
        });
        if (!session?.isActive) { emit(socket, 'error', { code: 'NOT_SEATED', message: 'Not seated at this table' }); return; }

        socket.join(tableRoom(tableId));
        (socket as any).currentTableId = tableId;

        const engine = await roomManager.getOrCreate(tableId);

        // Re-add player to engine if they were removed (e.g. after leaving then rejoining)
        const hasSeat = engine.getState().seats.find((s: any) => s.userId === userId);
        if (!hasSeat) {
          engine.addPlayer({
            seatIndex:   session.seatIndex,
            userId,
            username:    session.user.username,
            displayName: session.user.displayName,
            avatarId:    session.user.avatarId,
            stack:       Number(session.currentStack),
            status:      'WAITING' as const,
            timeBank:    30,
            isConnected: false,
            isBot:       session.user.username === 'StackBot',
          });
        }

        engine.setConnected(userId, true);
        markTableActive(tableId);
        emit(socket, 'game_state', engine.buildClientView(userId));

        socket.to(tableRoom(tableId)).emit('player_reconnected', { event: 'player_reconnected', data: { userId, username }, ts: Date.now() });

        if (engine.canStartHand()) setTimeout(() => engine.startHand(), 1500);
      } catch (err) {
        logger.error('join_table error:', err);
        emit(socket, 'error', { code: 'SERVER_ERROR', message: 'Failed to join table' });
      }
    });

    socket.on('player_action', (payload: { tableId: string; action: string; amount?: number }) => {
      try {
        const { tableId, action, amount } = payload;
        const engine = roomManager.get(tableId);
        if (!engine) { emit(socket, 'error', { code: 'NO_GAME', message: 'No active game' }); return; }
        const result = engine.processAction(userId, action as any, amount);
        if (!result.ok) { emit(socket, 'error', { code: 'INVALID_ACTION', message: result.error ?? 'Invalid action' }); return; }
        markTableActive(tableId);
        io.to(tableRoom(tableId)).emit('player_action', { event: 'player_action', data: { userId, username, action, amount, ts: Date.now() }, ts: Date.now() });
      } catch (err) {
        logger.error('player_action error:', err);
        emit(socket, 'error', { code: 'SERVER_ERROR', message: 'Action failed' });
      }
    });

    socket.on('leave_table', async (payload: { tableId: string }) => {
      const { tableId } = payload;
      socket.leave(tableRoom(tableId));
      const engine = roomManager.get(tableId);
      if (engine) {
        engine.removePlayer(userId);
        socket.to(tableRoom(tableId)).emit('player_left', { event: 'player_left', data: { userId, username }, ts: Date.now() });
      }
      (socket as any).currentTableId = null;

      // Cancel any pending grace-period cleanup — we're leaving explicitly
      // now, no need to wait.
      const pending = sessionCleanupTimers.get(cleanupKey(tableId, userId));
      if (pending) {
        clearTimeout(pending);
        sessionCleanupTimers.delete(cleanupKey(tableId, userId));
      }

      // Free the seat in the DB (mark session inactive, return chips, close
      // the table if it just emptied). Without this, the lobby keeps
      // counting the user as seated forever.
      await autoLeave(userId, tableId);
    });

    socket.on('table_chat', (payload: { tableId: string; message: string }) => {
      const { tableId, message } = payload;
      if (!message?.trim() || message.length > 200) return;
      const cleanMsg = message.trim();
      markTableActive(tableId);
      io.to(tableRoom(tableId)).emit('table_chat', { event: 'table_chat', data: { userId, username, message: cleanMsg, ts: Date.now() }, ts: Date.now() });

      // If the sender isn't the bot and a bot is at the table, have StackBot
      // reply with poker-flavoured chat after a short typing delay.
      const engine = roomManager.get(tableId);
      const botSeat = engine?.getState().seats.find(s => s.isBot);
      if (!botSeat || botSeat.userId === userId) return;

      const reply = generateBotReply(cleanMsg);
      if (!reply) return;
      const delay = botTypingDelayMs(reply);
      setTimeout(() => {
        // Re-check the bot is still seated in case they left mid-delay
        const stillThere = roomManager.get(tableId)?.getState().seats.find(s => s.isBot);
        if (!stillThere) return;
        io.to(tableRoom(tableId)).emit('table_chat', {
          event: 'table_chat',
          data: {
            userId:   stillThere.userId,
            username: stillThere.username,
            message:  reply,
            ts:       Date.now(),
          },
          ts: Date.now(),
        });
      }, delay);
    });

    socket.on('admin_kick', async (payload: { tableId: string; targetUserId: string }) => {
      const { tableId, targetUserId } = payload;
      const table = await prisma.pokerTable.findUnique({ where: { id: tableId } });
      if (!table || table.ownerId !== userId) { emit(socket, 'error', { code: 'FORBIDDEN', message: 'Owner only' }); return; }
      const engine = roomManager.get(tableId);
      if (engine) engine.removePlayer(targetUserId);
      const socks = await io.in(tableRoom(tableId)).fetchSockets();
      const target = socks.find(s => (s as any).userId === targetUserId);
      if (target) { target.emit('kicked', { message: 'Removed by host' }); target.leave(tableRoom(tableId)); }
      io.to(tableRoom(tableId)).emit('player_kicked', { event: 'player_kicked', data: { userId: targetUserId }, ts: Date.now() });
    });

    socket.on('ping', () => emit(socket, 'pong', { ts: Date.now() }));

    socket.on('disconnect', () => {
      const tableId = (socket as any).currentTableId as string | null;
      if (tableId) {
        const engine = roomManager.get(tableId);
        if (engine) engine.setConnected(userId, false);
        socket.to(tableRoom(tableId)).emit('player_disconnected', { event: 'player_disconnected', data: { userId, username }, ts: Date.now() });

        // Schedule a grace-period auto-leave. If the user reconnects via
        // join_table before this fires, the timer is cancelled there. If
        // they don't come back, we free their seat (chips returned, lobby
        // count decremented, table closed if empty) so the lobby doesn't
        // show ghost players forever.
        const key = cleanupKey(tableId, userId);
        const existing = sessionCleanupTimers.get(key);
        if (existing) clearTimeout(existing);
        const timer = setTimeout(() => {
          sessionCleanupTimers.delete(key);
          void autoLeave(userId, tableId);
        }, DISCONNECT_GRACE_MS);
        sessionCleanupTimers.set(key, timer);
      }
    });
  });

  logger.info('Socket.IO handlers registered');
}
