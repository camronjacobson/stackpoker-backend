import { Server as SocketServer, Socket } from 'socket.io';
import jwt from 'jsonwebtoken';
import { TokenPayload } from '../shared/types';
import { ServerGameState } from './gameState.types';
import { roomManager } from './roomManager';
import { logger } from '../shared/utils';
import { PrismaClient } from '@prisma/client';
import { generateBotReply, botTypingDelayMs } from './botChat';
import * as lobbyService from '../lobby/lobby.service';

// MAP: socket.handler — Socket.IO event routing for /game ns (382 lines)
// - broadcastGameState (per-recipient view)  L164
// - registerSocketHandlers (entry) ......... L175
// - join_table ............................. L197
// - player_action .......................... L250
// - show_cards (voluntary fold-show) ....... L271
// - leave_table ............................ L286
// - table_chat ............................. L310
// - admin_kick ............................. L343
// - disconnect (with grace period) ......... L357

const prisma = new PrismaClient();

// Disconnect grace period — when a socket drops we don't immediately free
// the seat; we wait this long for a reconnect (network blip, app
// foreground/background, etc). If the user doesn't come back, we run the
// real `leaveTable` flow to return chips and free the lobby slot. Without
// this, sessions accumulate forever and the lobby shows ghost players.
//
// Cleanup is DB-driven (TableSession.disconnectedAt) rather than via an
// in-memory setTimeout map. Reason: in-memory timers vanish on process
// restart (Railway redeploy, crash), leaving permanent ghost sessions that
// the idle-table sweeper can't touch because it only closes whole tables
// with zero active sessions. The DB column lets the sweeper recover after
// any restart by checking `disconnectedAt < now - grace` on boot.
const DISCONNECT_GRACE_MS = 90_000;
// Explicit-leave grace — when the user taps "Leave Table" with chips still
// in front of them, we treat it as a "soft leave": the DB session stays
// active so they can press "Join Game" on the same table and slide back in
// with their existing stack (no second buy-in). If they don't return within
// this window, we run the real cash-out flow. Aligned with TABLE_IDLE_MS so
// an abandoned table and an abandoned seat clean up together.
const LEAVE_GRACE_MS = 90_000;

// Stamp the session as "waiting for reconnect". Idempotent — re-stamping on
// a still-disconnected session just refreshes the timer (matches the old
// `clearTimeout + setTimeout` semantics).
async function markSessionDisconnected(userId: string, tableId: string) {
  try {
    await prisma.tableSession.updateMany({
      where: { tableId, userId, isActive: true },
      data:  { disconnectedAt: new Date() },
    });
  } catch (err) {
    logger.error('markSessionDisconnected failed:', err);
  }
}

// Reverse of the above — call on rejoin so the sweeper stops considering
// this session a cleanup candidate.
async function clearSessionDisconnected(userId: string, tableId: string) {
  try {
    await prisma.tableSession.updateMany({
      where: { tableId, userId, isActive: true },
      data:  { disconnectedAt: null },
    });
  } catch (err) {
    logger.error('clearSessionDisconnected failed:', err);
  }
}

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

  // Drop the in-memory engine for this table. Any DB-side disconnect
  // stamps will become moot since the transaction above already flipped
  // every session to isActive=false (the sweeper filters by isActive).
  roomManager.destroy(tableId);
  lastHumanActivityAt.delete(tableId);

  // Notify any sockets still in the room (shouldn't be any, but be safe).
  io.to(tableRoom(tableId)).emit('table_closed', {
    event: 'table_closed',
    data: { tableId, reason: 'idle' },
    ts: Date.now(),
  });
}

// Find sessions stamped with `disconnectedAt` older than the grace window
// and run autoLeave on them. This is the survives-restart replacement for
// the old in-memory setTimeout map. Runs alongside sweepIdleTables on the
// same interval — cheap query, indexed on isActive.
async function sweepDisconnectedSessions(): Promise<void> {
  // Use the larger of the two grace windows so a soft-leave (LEAVE_GRACE_MS)
  // never gets cut short. Both are 90s today but keep the max() so future
  // tuning of either constant stays safe.
  const graceMs = Math.max(DISCONNECT_GRACE_MS, LEAVE_GRACE_MS);
  const cutoff  = new Date(Date.now() - graceMs);

  const stale = await prisma.tableSession.findMany({
    where: {
      isActive: true,
      disconnectedAt: { not: null, lt: cutoff },
    },
    select: { userId: true, tableId: true },
  });

  for (const s of stale) {
    logger.info(`Disconnect sweep: auto-leaving ${s.userId} from ${s.tableId}`);
    await autoLeave(s.userId, s.tableId);
  }
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

      // No live sockets. Before declaring idle, check if any human (non-bot)
      // session is still active in the DB — that covers the soft-leave grace
      // window where the user has left the WebSocket but their seat is still
      // reserved for a rejoin. Without this, the 15s sweep races the rejoin
      // and forceClose nukes the table (along with the bot) ~90s after the
      // human leaves, even though they intended to come back. The DB count
      // is cheap and only runs in the "no sockets" branch.
      const humanActive = await prisma.tableSession.count({
        where: {
          tableId:  t.id,
          isActive: true,
          user: { username: { not: 'StackBot' } },
        },
      });
      if (humanActive > 0) {
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
  // Run the disconnected-session sweeper on the same cadence. Order doesn't
  // matter — sessions that get auto-left here will be reflected in the
  // table sweep on the next tick.
  setInterval(() => { void sweepDisconnectedSessions(); }, SWEEP_INTERVAL_MS);

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

        // Reconnecting before the grace period elapsed — clear the
        // disconnect stamp so the sweeper stops considering this session a
        // cleanup candidate. Safe to fire-and-await even if the column was
        // already null (updateMany is a no-op in that case).
        await clearSessionDisconnected(userId, tableId);

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
            // 15s fixed-per-turn budget, no persistent time bank. Players
            // get a single +15s extension via request_time_extension.
            timeBank:    0,
            isConnected: false,
            isBot:       session.user.username === 'StackBot',
          });
        } else {
          // Seat still exists — typically means we left mid-hand and the
          // engine kept the seat with `pendingLeave=true` so the current
          // hand could finish payouts. Without clearing this flag here,
          // the end-of-hand cleanup filter (gameEngine.ts:1423) evicts
          // the returning user as soon as the current hand wraps,
          // leaving them with a greyed-out "Left" badge that then
          // disappears entirely. Clearing `pendingLeave` on rejoin
          // cancels the eviction; the user is still FOLDED for the
          // in-progress hand (correct — they really did fold when they
          // tapped leave) but startHand will reset them to ACTIVE for
          // the next deal.
          hasSeat.pendingLeave = undefined;
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

    // Player tapped the +15s pill to extend their decision time. The engine
    // enforces: must be your turn, one extension max per turn. Silent no-op
    // on rejection — iOS already locally hides the button after tapping, so
    // bouncing an error toast for a stale/spammed tap would be noise.
    socket.on('request_time_extension', (payload: { tableId: string }) => {
      try {
        const { tableId } = payload;
        const engine = roomManager.get(tableId);
        if (!engine) return;
        const ok = engine.requestTimeExtension(userId);
        if (!ok) return;
        markTableActive(tableId);
        // Re-broadcast so every seat sees the new actionDeadline tick up.
        void broadcastGameState(io, tableId);
      } catch (err) {
        logger.error('request_time_extension error:', err);
      }
    });

    // Player tapped one of their own hole cards to voluntarily expose it.
    // We trust the engine to validate the index range / hand state — the
    // handler just relays and re-broadcasts so every viewer sees the
    // updated `revealedCards` field at the affected seat. We do NOT echo
    // a separate event; the per-recipient broadcastGameState already
    // routes a fresh ClientGameState with the new reveal baked in.
    // `handNumber` is optional in the payload to preserve compatibility with
    // older TestFlight builds that ship without it. Newer builds include it
    // so the engine can drop a tap that landed during the next hand.
    socket.on('show_cards', (payload: { tableId: string; cardIndex: number; handNumber?: number }) => {
      try {
        const { tableId, cardIndex, handNumber } = payload;
        const engine = roomManager.get(tableId);
        if (!engine) { emit(socket, 'error', { code: 'NO_GAME', message: 'No active game' }); return; }
        const added = engine.showCard(userId, cardIndex, handNumber);
        if (!added) return; // bad index, no hand, stale handNumber, or duplicate — silently ignore
        markTableActive(tableId);
        void broadcastGameState(io, tableId);
      } catch (err) {
        logger.error('show_cards error:', err);
        emit(socket, 'error', { code: 'SERVER_ERROR', message: 'Show cards failed' });
      }
    });

    socket.on('leave_table', async (payload: { tableId: string }) => {
      const { tableId } = payload;
      socket.leave(tableRoom(tableId));

      // Read the seat's stack BEFORE removePlayer wipes it. This decides
      // whether the leave is "soft" (chips remain, session stays active so
      // the user can press Join Game and slide back in with the same stack)
      // or "hard" (busted with 0 chips → close the seat now and return
      // whatever is left to chipBalance via autoLeave).
      const engine = roomManager.get(tableId);
      const seat   = engine?.getState().seats.find((s: any) => s.userId === userId);
      const stack  = seat ? Number(seat.stack) : 0;

      if (engine) {
        engine.removePlayer(userId);
        socket.to(tableRoom(tableId)).emit('player_left', { event: 'player_left', data: { userId, username }, ts: Date.now() });
      }
      (socket as any).currentTableId = null;

      if (stack > 0) {
        // Soft leave: keep the DB session active so a subsequent join_table
        // re-seats the user with `currentStack` (no second buy-in). Stamp
        // `disconnectedAt` so the DB-driven sweeper auto-leaves them if
        // they don't come back within LEAVE_GRACE_MS.
        await markSessionDisconnected(userId, tableId);
      } else {
        // Hard leave (busted, or seat already gone): free the slot now so
        // the lobby stops counting them as seated.
        await autoLeave(userId, tableId);
      }
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

        // Stamp the session as disconnected. The periodic sweeper picks
        // up rows older than DISCONNECT_GRACE_MS and runs autoLeave. If
        // the user reconnects via join_table before then, that handler
        // clears the stamp and the row is no longer a sweep candidate.
        // Using the DB (vs an in-memory setTimeout) means cleanup
        // survives process restarts — load-test bots that died during a
        // Railway redeploy used to leak sessions forever this way.
        void markSessionDisconnected(userId, tableId);
      }
    });
  });

  logger.info('Socket.IO handlers registered');
}
