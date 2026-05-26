import { Server as SocketServer, Socket } from 'socket.io';
import jwt from 'jsonwebtoken';
import { TokenPayload } from '../shared/types';
import { ServerGameState } from './gameState.types';
import { roomManager } from './roomManager';
import { logger } from '../shared/utils';
import { PrismaClient } from '@prisma/client';
import * as lobbyService from '../lobby/lobby.service';
import { BOT_USERNAMES, isBotUsername } from './botService';
import { getEquippedForUsers } from '../cosmetics/cosmetics.service';

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
  logger.info(`[STATE] event=auto_leave_start userId=${userId} tableId=${tableId}`);
  try {
    await lobbyService.leaveTable(userId, tableId);
    logger.info(`Auto-leave: freed ${userId} from ${tableId} after grace period`);
    logger.info(`[STATE] event=auto_leave_success userId=${userId} tableId=${tableId}`);
  } catch (err: any) {
    // GAME_IN_PROGRESS / NOT_AT_TABLE are expected non-errors — the user
    // either left already or is mid-hand. Anything else is real.
    if (err?.code !== 'GAME_IN_PROGRESS' && err?.code !== 'NOT_AT_TABLE') {
      logger.error('autoLeave failed:', err);
      logger.warn(`[STATE] event=auto_leave_error userId=${userId} tableId=${tableId} code=${err?.code ?? 'UNKNOWN'}`);
    } else {
      logger.info(`[STATE] event=auto_leave_skipped userId=${userId} tableId=${tableId} code=${err.code}`);
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

// Exported for tests (balanceMutations.test.ts). Not part of the public API
// surface — the only production caller is the idle-table sweeper below.
export async function forceCloseIdleTable(io: SocketServer, tableId: string): Promise<void> {
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
  // Track which users we credited so we can emit your_chips_updated to each
  // of them after the transaction commits — they may still have an active
  // socket (e.g. lobby view) that needs to refresh its HUD without a relaunch.
  // Map: userId → post-credit chipBalance (string).
  const creditedBalances = new Map<string, string>();

  if (sessions.length > 0) {
    await prisma.$transaction(async (tx) => {
      await tx.pokerTable.update({
        where: { id: tableId },
        data: { status: 'CLOSED', closedAt: now },
      });
      await tx.tableSession.updateMany({
        where: { tableId, isActive: true },
        data: { isActive: false, leftAt: now },
      });
      for (const s of sessions) {
        // Skip the credit for sessions that already had chips returned via
        // softLeaveCashOut — re-incrementing here would double-pay. The
        // CASH_OUT transaction was written at soft-leave time.
        if (s.chipsReturned) continue;
        const u = await tx.user.update({
          where: { id: s.userId },
          data: { chipBalance: { increment: s.currentStack } },
          select: { chipBalance: true },
        });
        await tx.chipTransaction.create({
          data: {
            recipientId: s.userId,
            amount: s.currentStack,
            type: 'CASH_OUT',
            tableId,
            description: 'Auto cash-out (idle table)',
          },
        });
        creditedBalances.set(s.userId, u.chipBalance.toString());
      }
    });
  } else {
    // No active sessions — just flip the table to CLOSED. Single update is
    // cheaper than the txn callback for the common empty-table case.
    await prisma.pokerTable.update({
      where: { id: tableId },
      data: { status: 'CLOSED', closedAt: now },
    });
  }

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

  // Per-user balance updates: hit the userRoom for every refunded session.
  // Backgrounded apps with an open socket will still receive these; cold-
  // start clients will pick up the right balance from /auth/me on next launch.
  for (const [userId, newBalance] of creditedBalances) {
    emitChipsUpdated(io, userId, newBalance, 'idle_table_closed');
  }
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

  if (stale.length > 0) {
    logger.info(`[STATE] event=disconnect_sweep_tick staleCount=${stale.length} cutoffMs=${cutoff.toISOString()} ids=${stale.map(s => `${s.userId}@${s.tableId}`).join(',')}`);
  }

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
          user: { username: { notIn: [...BOT_USERNAMES] } },
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
      logger.info(`[STATE] event=idle_sweep_close tableId=${t.id} name=${t.name} idleSeconds=${Math.round((now - last) / 1000)}`);
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

// ─── your_chips_updated emit helper ─────────────────────────────────────────
// Canonical socket-side mechanism for telling a user that their wallet
// balance has changed (parallel to the REST `newBalance` response field).
// Targets the user's personal room (userRoom) so every device of that user
// receives the update — table-scoped emits would miss tabs/sessions not at
// the table that triggered the change. `reason` is a short tag for
// debugging/telemetry; iOS doesn't branch on it today.
//
// See TECH_DEBT.md ("Balance sync via socket"). Any future server-side chip
// mutation that isn't tied to an HTTP response should emit through here
// rather than inventing a new event name.
function emitChipsUpdated(
  io: SocketServer,
  userId: string,
  newBalance: string,
  reason: string,
) {
  io.to(userRoom(userId)).emit('your_chips_updated', {
    event: 'your_chips_updated',
    data: { newBalance, reason },
    ts: Date.now(),
  });
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
    logger.info(`[STATE] event=ws_connect userId=${userId} username=${username} socketId=${socket.id}`);
    socket.join(userRoom(userId));

    socket.on('join_table', async (payload: { tableId: string }) => {
      try {
        const { tableId } = payload;
        logger.info(`[STATE] event=ws_join_table_start userId=${userId} tableId=${tableId} socketId=${socket.id}`);

        // Re-debit the wallet if the user soft-left with chips and is now
        // returning. This MUST run before we read the session below so the
        // chipsReturned flag is cleared atomically with the chip transfer
        // — otherwise a second `join_table` racing this one could see
        // chipsReturned still true and try to re-debit again. Throws
        // INSUFFICIENT_CHIPS if the user spent the cashed-out chips
        // elsewhere; we surface that as a normal error event.
        try {
          const r = await lobbyService.rejoinRedebit(userId, tableId);
          // CHIP MUTATION: server returned newBalance; sync HUD via socket.
          // Emit even on the didDebit=false no-op path so any HUD that drifted
          // from another mutation source gets refreshed on rejoin.
          emitChipsUpdated(io, userId, r.newBalance, r.didDebit ? 'rejoin_redebit' : 'rejoin_noop');
        } catch (err: any) {
          if (err?.code === 'INSUFFICIENT_CHIPS') {
            logger.warn(`[STATE] event=ws_join_table_error reason=INSUFFICIENT_CHIPS userId=${userId} tableId=${tableId} message="${err.message}"`);
            emit(socket, 'error', { code: err.code, message: err.message });
            return;
          }
          throw err;
        }

        // Reconnecting before the grace period elapsed — clear the
        // disconnect stamp so the sweeper stops considering this session a
        // cleanup candidate. Safe to fire-and-await even if the column was
        // already null (updateMany is a no-op in that case). rejoinRedebit
        // also clears it on the soft-leave path; this covers plain socket
        // drops where chipsReturned was never set.
        await clearSessionDisconnected(userId, tableId);

        let session = await prisma.tableSession.findUnique({
          where: { tableId_userId: { tableId, userId } },
          include: { user: { select: { username: true, displayName: true, avatarId: true } } },
        });
        if (!session?.isActive) {
          // Auto-recover from a swept session. The sweeper-vs-rejoin race
          // (Symptom 1/2): disconnect sweeper flipped isActive=false between
          // the soft-leave and this rejoin attempt, leaving the row in place
          // with the seatIndex and currentStack still set. reactivateSession
          // re-debits the wallet, clears the away markers, and flips it back
          // active in a single transaction. If it returns non-null, fall
          // through to the normal join path below (re-read the session so
          // the user-include is fresh). Returns null when there's genuinely
          // no session row at all — that's the real NOT_SEATED case.
          try {
            const reactivated = await lobbyService.reactivateSession(userId, tableId);
            if (reactivated) {
              emitChipsUpdated(io, userId, reactivated.newBalance, 'reactivate_swept_session');
              session = await prisma.tableSession.findUnique({
                where: { tableId_userId: { tableId, userId } },
                include: { user: { select: { username: true, displayName: true, avatarId: true } } },
              });
            }
          } catch (err: any) {
            if (err?.code === 'TABLE_CLOSED' || err?.code === 'INSUFFICIENT_CHIPS' || err?.code === 'NOT_FOUND') {
              logger.warn(`[STATE] event=ws_join_table_error reason=${err.code} userId=${userId} tableId=${tableId} message="${err.message}"`);
              emit(socket, 'error', { code: err.code, message: err.message });
              return;
            }
            throw err;
          }
        }
        if (!session?.isActive) {
          // Reactivation returned null (no session row) — genuine NOT_SEATED.
          logger.warn(`[STATE] event=ws_join_table_error reason=NOT_SEATED userId=${userId} tableId=${tableId} sessionFound=${!!session} isActive=${session?.isActive ?? null}`);
          emit(socket, 'error', { code: 'NOT_SEATED', message: 'Not seated at this table' });
          return;
        }

        socket.join(tableRoom(tableId));
        (socket as any).currentTableId = tableId;

        const engine = await roomManager.getOrCreate(tableId);

        // Re-add player to engine if they were removed (e.g. after leaving then rejoining)
        const hasSeat = engine.getState().seats.find((s: any) => s.userId === userId);
        if (!hasSeat) {
          // Single-user equipped lookup — same helper as roomManager,
          // called with a one-element list so we don't fork the code
          // path. Read once on rejoin; mid-session equip changes don't
          // refresh until the next rejoin (Phase 5 / TECH_DEBT).
          const equippedByUser = await getEquippedForUsers([userId]);
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
            isBot:       isBotUsername(session.user.username),
            equippedCosmetics: equippedByUser.get(userId) ?? {},
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
        logger.info(`[STATE] event=ws_join_table_success userId=${userId} tableId=${tableId} seatIndex=${session.seatIndex} stack=${session.currentStack.toString()} reAdded=${!hasSeat}`);
      } catch (err: any) {
        logger.error('join_table error:', err);
        logger.warn(`[STATE] event=ws_join_table_error reason=SERVER_ERROR userId=${userId} tableId=${payload?.tableId ?? 'unknown'} code=${err?.code ?? 'UNKNOWN'} message="${err?.message ?? String(err)}"`);
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
        // Soft leave (Option C): return chips to the wallet IMMEDIATELY so
        // the user sees the cash-out reflected in their lobby balance right
        // away, while keeping the DB session row active so a rejoin within
        // grace can re-debit and reseat at the same stack. The sweeper
        // calls leaveTable after the grace window, which sees
        // `chipsReturned=true` and skips the credit so chips are never
        // paid twice.
        try {
          const r = await lobbyService.softLeaveCashOut(userId, tableId);
          // CHIP MUTATION: server returned newBalance; sync HUD via socket.
          // This is the bug-class the user originally reported — leaving a
          // table credited chips back to the wallet but the in-session HUD
          // didn't notice.
          emitChipsUpdated(io, userId, r.newBalance, 'cash_out');
        } catch (err: any) {
          if (err?.code === 'GAME_IN_PROGRESS') {
            // Engine already removed the seat above; the hand-end cleanup
            // path will cash them out at end-of-hand. Fall back to the
            // legacy "stamp disconnect" behavior so the sweeper handles it.
            await markSessionDisconnected(userId, tableId);
          } else {
            logger.error('softLeaveCashOut failed:', err);
            await markSessionDisconnected(userId, tableId);
          }
        }
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
      // Bot chat reply was removed — StackBot is silent. The keyword-driven
      // canned replies (see deleted botChat.ts) felt off-brand and produced
      // noise in the chat feed. Human-to-human chat still flows through the
      // emit above.
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

    socket.on('disconnect', (reason: string) => {
      const tableId = (socket as any).currentTableId as string | null;
      // Socket.IO disconnect reasons include 'client namespace disconnect'
      // (intentional client-side .disconnect()), 'transport close' (network
      // drop), 'ping timeout' (heartbeat miss), 'transport error', etc.
      // Distinguishing these tells us if "can't rejoin" is preceded by an
      // intentional teardown vs an unexpected drop.
      logger.info(`[STATE] event=ws_disconnect userId=${userId} username=${username} socketId=${socket.id} reason=${reason} currentTableId=${tableId ?? 'none'}`);
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
