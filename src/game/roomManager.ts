import { PokerGameEngine } from './gameEngine';
import { ServerGameState, WinnerPayout } from './gameState.types';
import { PrismaClient } from '@prisma/client';
import { logger } from '../shared/utils';
import { isBotUsername } from './botService';
import { getEquippedForUsers } from '../cosmetics/cosmetics.service';

const prisma = new PrismaClient();

// ─── Room Manager ─────────────────────────────────────────────────────────────
// Keeps one PokerGameEngine per active table, in-process memory.
// For multi-server deployments, replace with Redis-backed state.

class GameRoomManager {
  private engines = new Map<string, PokerGameEngine>();
  private broadcastFn?: (tableId: string, state: ServerGameState) => void;
  private handEndFn?:   (tableId: string, state: ServerGameState) => void;

  setBroadcastFn(fn: (tableId: string, state: ServerGameState) => void) { this.broadcastFn = fn; }
  setHandEndFn(fn: (tableId: string, state: ServerGameState) => void)   { this.handEndFn   = fn; }

  async getOrCreate(tableId: string): Promise<PokerGameEngine> {
    if (this.engines.has(tableId)) return this.engines.get(tableId)!;

    // Load table from DB
    const table = await prisma.pokerTable.findUnique({
      where: { id: tableId },
      include: {
        sessions: {
          where: { isActive: true },
          include: { user: { select: { id: true, username: true, displayName: true, avatarId: true } } },
        },
      },
    });

    if (!table) throw new Error(`Table ${tableId} not found`);

    // Bulk-fetch equipped cosmetics for every seated user in one query.
    // Cheaper than N findFirst calls; safe to await before engine boot
    // since engine creation is on the table-join hot path but is gated
    // by an in-memory check at the top of getOrCreate (so this only
    // runs once per server-life-per-table). Bots have no equip rows →
    // they're absent from the map → they render the default card back
    // on iOS via the `?? {}` fallback below.
    const userIds = table.sessions.map(s => s.userId);
    const equippedByUser = await getEquippedForUsers(userIds);

    const seats = table.sessions.map(s => ({
      seatIndex:   s.seatIndex,
      userId:      s.userId,
      username:    s.user.username,
      displayName: s.user.displayName,
      avatarId:    s.user.avatarId,
      stack:       Number(s.currentStack),
      status:      'WAITING' as const,
      // No persistent time bank — players get a fixed 15s per turn and can
      // tap "+15s" once per turn to extend (see TIME_EXTENSION_MS in
      // gameEngine.ts). Keeping this at 0 means actionDeadline math
      // collapses to just TURN_DURATION_MS.
      timeBank:    0,
      isConnected: false,
      // Tag bot seats so the engine auto-acts on their turn. Without this,
      // after a server restart the bot seat loses its isBot flag and only
      // moves via the 30-second disconnect auto-fold.
      isBot:       isBotUsername(s.user.username),
      // Equipped cosmetics snapshot — read once at table-join. See note
      // on Seat.equippedCosmetics about deferred mid-session refresh.
      equippedCosmetics: equippedByUser.get(s.userId) ?? {},
    }));

    const engine = new PokerGameEngine(
      tableId,
      seats,
      Number(table.smallBlind),
      Number(table.bigBlind),
      (state) => {
        this.broadcastFn?.(tableId, state);
      },
      (state) => {
        this.handEndFn?.(tableId, state);
        this.persistHandResult(tableId, state).catch(err => logger.error('persist hand error', err));
      },
      (table as any).gameType ?? 'TEXAS_HOLDEM',
    );

    this.engines.set(tableId, engine);
    logger.info(`Engine created for table ${tableId} with ${seats.length} seats`);
    return engine;
  }

  get(tableId: string): PokerGameEngine | undefined {
    return this.engines.get(tableId);
  }

  destroy(tableId: string): void {
    this.engines.delete(tableId);
    logger.info(`Engine destroyed for table ${tableId}`);
  }

  // ─── Persist hand result to DB ────────────────────────────────────────────

  private async persistHandResult(tableId: string, state: ServerGameState): Promise<void> {
    if (!state.winners?.length) return;

    try {
      const winnerIds  = state.winners.map(w => w.playerId);
      const primaryWin = state.winners[0];

      // Pull the per-hand VPIP set from the engine *before* the next hand's
      // startHand() clears it. The Set→Set lookup below is O(1) per seat.
      const voluntaryIds = new Set(
        this.engines.get(tableId)?.getVoluntaryPreflopUserIds() ?? []
      );

      // Create hand history record
      const hand = await prisma.handHistory.create({
        data: {
          tableId,
          handNumber:    state.handNumber,
          communityCards: state.communityCards.map(c => `${c.rank}${c.suit}`),
          pot:           BigInt(state.winners.reduce((s, w) => s + w.amount, 0)),
          winnerId:      primaryWin.playerId,
          winnerIds,
          handStrength:  primaryWin.handName,
          duration:      Math.round((Date.now() - state.handStartedAt) / 1000),
        },
      });

      // Update player chip balances and stats. handsPlayed only increments
      // for seats that were actually dealt in (status FOLDED/ACTIVE/ALL_IN
      // at hand end) — SITTING_OUT seats are spectators this hand and
      // shouldn't dilute VPIP%. WAITING shouldn't appear at hand end (it's
      // pre-deal), but we exclude it defensively.
      const dealtIn = (status: string) =>
        status === 'ACTIVE' || status === 'ALL_IN' || status === 'FOLDED';

      await Promise.all(
        state.seats.map(seat => {
          const wasDealtIn = dealtIn(seat.status);
          const isWinner   = winnerIds.includes(seat.userId);
          const wasVoluntary = voluntaryIds.has(seat.userId);
          return prisma.$transaction([
            prisma.tableSession.updateMany({
              where: { tableId, userId: seat.userId, isActive: true },
              data: { currentStack: BigInt(seat.stack) },
            }),
            prisma.user.update({
              where: { id: seat.userId },
              data: {
                ...(wasDealtIn ? { handsPlayed: { increment: 1 } } : {}),
                ...(wasDealtIn && wasVoluntary ? { vpipHands: { increment: 1 } } : {}),
                ...(isWinner ? {
                  totalWon: { increment: BigInt(state.winners!.find(w => w.playerId === seat.userId)?.amount ?? 0) },
                } : {}),
              },
            }),
          ]);
        })
      );

      logger.info(`Hand #${state.handNumber} persisted for table ${tableId}`);

      // ── Bot bust-out: remove StackBot from the session when it busts ──
      // A human who busts gets parked at SITTING_OUT so they can manually
      // top up and rejoin (gameEngine end-hand cleanup at lines ~1497-1498).
      // The bot has no one to "top up" for it, so leaving it parked at
      // stack=0 just clogs the seat — the table can't fill the slot, and
      // canStartHand keeps gating on a SITTING_OUT seat that will never
      // wake. Splice the bot out of the engine and mark its DB session
      // inactive so the slot frees up for a real player to join.
      //
      // We do this in persistHandResult (rather than in gameEngine's own
      // cleanup) because the engine is intentionally agnostic of the DB
      // layer — only the room manager owns the tableSession lifecycle.
      const engineNow = this.engines.get(tableId);
      if (engineNow) {
        const bustedBots = engineNow.getState().seats.filter(
          s => s.isBot && s.stack === 0,
        );
        for (const bot of bustedBots) {
          engineNow.removePlayer(bot.userId);
          await prisma.tableSession.updateMany({
            where: { tableId, userId: bot.userId, isActive: true },
            data:  { isActive: false, leftAt: new Date() },
          });
          logger.info(`Bot ${bot.username} busted at table ${tableId} — removed from session`);
        }
      }
    } catch (err) {
      logger.error('Failed to persist hand:', err);
    }
  }
}

export const roomManager = new GameRoomManager();
