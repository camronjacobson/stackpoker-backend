import { buildDeck, Card, RANK_VALUE } from './deck';
import { evaluateHand, evaluatePLOHand, determineWinners, PlayerHandResult, HandRank } from './handEvaluator';
import { buildPots, distributePots, totalPot } from './potManager';
import {
  ServerGameState, ClientGameState, Seat, Street, GamePhase, GameType,
  ActionType, LastAction, LegalAction, ClientSeat, WinnerPayout,
} from './gameState.types';
import { logger } from '../shared/utils';
import { hashStringToInt } from './botService';

// MAP: gameEngine — authoritative poker state machine (1108 lines)
// - PokerGameEngine class .................. L20
// - addPlayer .............................. L84
// - showCard (voluntary fold-show) ......... L128
// - startHand (deal, blinds, hole cards) ... L177
// - processAction (action validator/router)  L267
// - getLegalActions ........................ L316
// - buildClientView (per-recipient filter) . L359
// - foldPlayer (preserves seat.mucked) ..... L482
// - raisePlayer ............................ L507
// - advanceStreet (flop/turn/river) ........ L652
// - endHand (showdown, payouts, reset) ..... L996

// ─── Config ───────────────────────────────────────────────────────────────────

const TURN_DURATION_MS  = 15_000;   // 15 seconds per turn (was 30; iOS now grants +15s on demand)
const TIME_EXTENSION_MS = 15_000;   // bonus seconds granted by request_time_extension
const TIMEBANK_SECONDS  = 30;       // extra time bank
const MIN_PLAYERS       = 2;
const HAND_START_DELAY  = 6_000;    // ms after hand ends before new deal — gives the showdown reveal animation room to play
const SHOWDOWN_DURATION = 5_000;    // ms to show cards before clearing
// Pause inserted between the action that closes a betting round and the
// advanceStreet() emit that zeros every seat's betThisStreet. Without this
// delay both emits fire on the same Node tick → batched on one socket flush
// → the client's view of the closing player's bet collapses 0 → X → 0 inside
// a single SwiftUI animation transaction, so neither the chip-arrival nor
// the chips-to-pot transition has a visible frame to render against. 700ms
// is long enough for the spring on the bet-chip layer (response 0.65) to
// nearly settle while still feeling snappy at the table.
const CLOSE_ROUND_DELAY_MS = 700;
// Shorter close-round delay used when the closing action moved no chips
// (i.e. a check-around — every seat's betThisStreet is 0 at the moment the
// round closes). With nothing to animate onto the felt there's no reason to
// hold the full 700ms; this just makes the next street's deal feel snappier
// after a passive round. Still long enough that SwiftUI's transaction
// boundary isn't collapsed onto the same socket flush.
const CLOSE_ROUND_DELAY_NO_BETS_MS = 180;

// ─── Game Engine ─────────────────────────────────────────────────────────────

export class PokerGameEngine {
  private state: ServerGameState;
  private turnTimer: NodeJS.Timeout | null = null;
  // userIds who have already burned their one-per-turn +15s extension on the
  // current activePlayer. Cleared every time setActivePlayer advances the
  // action so each new turn gets a fresh extension allowance.
  private extensionUsedThisTurn: Set<string> = new Set();
  private disconnectTimers: Map<string, NodeJS.Timeout> = new Map();
  private lastAggressorId: string | null = null;
  // Players who have acted since the last bet/raise on the current street.
  // A betting round is complete only when every ACTIVE player is in this set
  // AND has matched the current bet. Cleared whenever currentBet increases.
  private actedSinceLastBet: Set<string> = new Set();
  // Per-hand set of userIds who voluntarily put money in the pot during the
  // PREFLOP street (CALL, RAISE, or ALL_IN). Cleared at the start of every
  // hand. The roomManager reads this when persisting hand results to bump
  // each user's `vpipHands` counter (the numerator of VPIP%).
  // Posted blinds do NOT count — VPIP only credits voluntary action.
  private voluntaryPreflopUserIds: Set<string> = new Set();
  private runoutTimer: NodeJS.Timeout | null = null;
  // Delays advanceGame() when the just-applied action closes the betting
  // round. Without this delay, the post-action emit (which carries the
  // closing player's bet badge) and the subsequent advanceStreet emit
  // (which zeros every betThisStreet to feed the pot) land on the same
  // Node tick — Socket.IO batches them onto the same flush, the iOS
  // client receives both states back-to-back, and SwiftUI collapses the
  // closing player's bet 0 → X → 0 into a single non-animating transition.
  // The bug presents as: "the caller's chips never visually arrive on the
  // felt or fly to the pot, even though the pot reflects the right amount".
  private closeRoundTimer: NodeJS.Timeout | null = null;
  private onStateChange: (state: ServerGameState) => void;
  private onHandEnd: (state: ServerGameState) => void;

  constructor(
    tableId: string,
    seats: Omit<Seat, 'holeCards' | 'mucked' | 'voluntaryShownCardIndices' | 'betThisStreet' | 'totalContributed' | 'isDealer' | 'isSmallBlind' | 'isBigBlind' | 'lastActionAt'>[],
    smallBlind: number,
    bigBlind: number,
    onStateChange: (state: ServerGameState) => void,
    onHandEnd: (state: ServerGameState) => void,
    gameType: GameType = 'TEXAS_HOLDEM',
  ) {
    this.onStateChange = onStateChange;
    this.onHandEnd     = onHandEnd;

    this.state = {
      tableId,
      gameType,
      handNumber:       0,
      phase:            'WAITING',
      street:           'PREFLOP',
      seats:            seats.map(s => ({
        ...s,
        holeCards:        [],
        mucked:           [],
        voluntaryShownCardIndices: [],
        betThisStreet:    0,
        totalContributed: 0,
        isDealer:         false,
        isSmallBlind:     false,
        isBigBlind:       false,
        lastActionAt:     Date.now(),
        pendingTopUp:     0,
      })),
      deck:             [],
      communityCards:   [],
      pots:             [],
      currentBet:       0,
      minRaise:         bigBlind,
      activePlayerId:   null,
      dealerSeatIndex:  -1,
      smallBlind,
      bigBlind,
      actionDeadline:   0,
      turnDuration:     TURN_DURATION_MS,
      lastAction:       null,
      winners:          null,
      handStartedAt:    0,
      runOutBoard:      [],
    };
  }

  // ─── Public API ─────────────────────────────────────────────────────────────

  getState(): ServerGameState { return this.state; }

  // Snapshot of userIds who voluntarily put money in preflop *during the
  // hand that just finished*. Returned as an array (not the live Set) so
  // callers can't mutate the engine's internal tracking. roomManager calls
  // this immediately after onHandEnd and before the next hand resets it.
  getVoluntaryPreflopUserIds(): string[] {
    return Array.from(this.voluntaryPreflopUserIds);
  }

  addPlayer(seat: Omit<Seat, 'holeCards'|'mucked'|'voluntaryShownCardIndices'|'betThisStreet'|'totalContributed'|'isDealer'|'isSmallBlind'|'isBigBlind'|'lastActionAt'>): void {
    const exists = this.state.seats.find(s => s.userId === seat.userId);
    if (exists) { exists.stack = seat.stack; exists.isConnected = true; return; }
    this.state.seats.push({
      ...seat,
      holeCards: [], mucked: [], voluntaryShownCardIndices: [],
      betThisStreet: 0, totalContributed: 0,
      isDealer: false, isSmallBlind: false, isBigBlind: false,
      lastActionAt: Date.now(),
      pendingTopUp: 0,
    });
    this.emit();
  }

  removePlayer(userId: string): void {
    const seat = this.state.seats.find(s => s.userId === userId);
    if (!seat) return;

    const betweenHands =
      this.state.phase === 'WAITING' || this.state.phase === 'ENDED';

    // Between-hand leave: free the seat immediately so others can sit.
    // Same when the player isn't part of the current hand at all
    // (SITTING_OUT) — there's nothing for them to leave behind.
    if (betweenHands || seat.status === 'SITTING_OUT') {
      this.state.seats = this.state.seats.filter(s => s.userId !== userId);
      this.emit();
      return;
    }

    // Mid-hand leave. Mark `pendingLeave` so the iOS client greys the
    // avatar out + labels it "Left", and so endHand's cleanup pass knows
    // to evict this seat once the hand finishes. Keeping the seat in the
    // array (rather than splice-removing now) preserves seat indices,
    // dealer/blind tracking, and any all-in showdown rights they have on
    // the chips already in the pot.
    seat.pendingLeave = true;

    if (seat.status === 'ACTIVE') {
      // Fold the leaving player so the betting round can proceed without
      // them. If it was their turn we also have to advance — `foldPlayer`
      // alone doesn't move action, it only mutates seat.status. Without
      // moveToNextPlayer the table sits frozen on a folded actor.
      const wasTheirTurn = this.state.activePlayerId === userId;
      this.foldPlayer(userId);
      if (wasTheirTurn) this.moveToNextPlayer();
    }
    // ALL_IN seats stay all-in — they're entitled to the showdown for the
    // chips they already committed. They're still flagged pendingLeave so
    // they get evicted at hand end.

    this.emit();
  }

  // Update a seat's stack in-memory (used by the rebuy / top-up flow). Only
  // safe to call between hands — the route layer is responsible for that
  // gate (see lobbyService.topUpChips). Emits so connected clients see the
  // new stack immediately rather than waiting for the next hand reload.
  //
  // A SITTING_OUT seat that just received positive chips is the bust-then-
  // rebuy case (gameEngine.ts:1497 parks busted players at SITTING_OUT with
  // stack=0). Without flipping back to WAITING the seat would stay invisible
  // to canStartHand, and a heads-up table with a bot opponent would deadlock
  // — only one eligible seat means no further hands ever start. Mirrors the
  // identical SITTING_OUT→WAITING transition in `applyPendingTopUps`.
  setStack(userId: string, stack: number): void {
    const seat = this.state.seats.find(s => s.userId === userId);
    if (!seat) return;
    seat.stack = stack;
    if (seat.status === 'SITTING_OUT' && seat.stack > 0) {
      seat.status = 'WAITING';
    }
    this.emit();
  }

  // Top-up requested mid-hand. The chips have already been deducted from the
  // user's bankroll by the time we get here (see lobby.service.topUpChips),
  // so this method only has to park the amount on the seat. `stack` stays
  // untouched until `applyPendingTopUps` drains the queue at end-of-hand —
  // this is the whole point of the mid-hand top-up flow: the user can
  // commit to buying more chips without their current hand's pot math,
  // all-in detection, or showdown rights getting distorted by the larger
  // stack. Returns true if the queue mutation happened (seat exists),
  // false otherwise (so the route layer can refund the user's bankroll).
  // Public so lobbyService can call it; emits a state push so the iOS
  // client can render the "+N pending" badge on the seat immediately.
  queueTopUp(userId: string, amount: number): boolean {
    if (!Number.isFinite(amount) || amount <= 0) return false;
    const seat = this.state.seats.find(s => s.userId === userId);
    if (!seat) return false;
    seat.pendingTopUp = (seat.pendingTopUp || 0) + amount;
    this.emit();
    return true;
  }

  // Drain any queued mid-hand top-ups into seat stacks. Called from
  // `endHand`'s setTimeout *after* winners are cleared and the seat status
  // pass runs — so a player who was SITTING_OUT with stack=0 because they
  // busted and queued a rebuy mid-hand correctly transitions back to
  // WAITING with their new stack. Idempotent: re-running with no pending
  // amounts is a no-op. Returns the per-user amounts that were applied so
  // the route layer (or roomManager.persistHandResult) can sync the DB.
  applyPendingTopUps(): { userId: string; amount: number; newStack: number }[] {
    const applied: { userId: string; amount: number; newStack: number }[] = [];
    for (const seat of this.state.seats) {
      const pending = seat.pendingTopUp || 0;
      if (pending <= 0) continue;
      seat.stack += pending;
      seat.pendingTopUp = 0;
      // A player who busted and queued a rebuy is now playable again.
      if (seat.status === 'SITTING_OUT' && seat.stack > 0) {
        seat.status = 'WAITING';
      }
      applied.push({ userId: seat.userId, amount: pending, newStack: seat.stack });
    }
    return applied;
  }

  // Player tapped one of their own hole cards to expose it to the table.
  // We accept the index ONLY when there is a hand to show (handNumber > 0)
  // and the index is in range for whichever array currently holds the
  // cards (mucked if folded, holeCards otherwise). Returns true if the
  // index was newly added so the caller knows whether to broadcast — a
  // duplicate tap is a no-op rather than an error so an over-eager double
  // tap doesn't blow up the socket. Idempotent.
  //
  // `requestHandNumber` (optional) closes the race where a player taps
  // reveal in the dying milliseconds of a hand: the tap travels the wire,
  // and meanwhile the server has already run startHand for the next hand.
  // Without a guard, the index gets pushed onto the *new* hand's seat and
  // exposes the wrong card for the entire next hand. When the client sends
  // its current handNumber along with the tap, we drop any tap that
  // doesn't match the engine's current hand. Older clients omit the field
  // and fall back to legacy behaviour so we don't break TestFlight builds
  // shipped before this guard existed.
  showCard(userId: string, cardIndex: number, requestHandNumber?: number): boolean {
    const seat = this.state.seats.find(s => s.userId === userId);
    if (!seat) return false;
    if (this.state.handNumber === 0) return false;
    if (requestHandNumber !== undefined && requestHandNumber !== this.state.handNumber) {
      return false;
    }
    const sourceLength = seat.status === 'FOLDED'
      ? seat.mucked.length
      : seat.holeCards.length;
    if (cardIndex < 0 || cardIndex >= sourceLength) return false;
    if (seat.voluntaryShownCardIndices.includes(cardIndex)) return false;
    seat.voluntaryShownCardIndices.push(cardIndex);
    return true;
  }

  setConnected(userId: string, connected: boolean): void {
    const seat = this.state.seats.find(s => s.userId === userId);
    if (!seat) return;

    seat.isConnected = connected;
    this.emit();

    if (!connected) {
      // Start a 30-second auto-fold timer if it is this player's turn
      if (this.state.activePlayerId === userId) {
        const timer = setTimeout(() => {
          this.disconnectTimers.delete(userId);
          if (this.state.activePlayerId === userId && seat.status === 'ACTIVE') {
            logger.info(`Auto-folding disconnected player ${userId}`);
            this.foldPlayer(userId);
            this.moveToNextPlayer();
          }
        }, 30_000);
        this.disconnectTimers.set(userId, timer);
      }
    } else {
      // Reconnected: cancel any pending disconnect timer
      const timer = this.disconnectTimers.get(userId);
      if (timer) {
        clearTimeout(timer);
        this.disconnectTimers.delete(userId);
        logger.info(`Player ${userId} reconnected, disconnect timer cancelled`);
      }
    }
  }

  canStartHand(): boolean {
    const active = this.state.seats.filter(s => s.status !== 'SITTING_OUT' && s.stack > 0);
    return active.length >= MIN_PLAYERS && this.state.phase === 'WAITING';
  }

  startHand(): void {
    if (!this.canStartHand()) return;

    this.state.handNumber++;
    this.state.phase          = 'DEALING';
    this.state.street         = 'PREFLOP';
    this.state.communityCards = [];
    this.state.pots           = [];
    this.state.currentBet     = this.state.bigBlind;
    this.state.minRaise       = this.state.bigBlind;
    this.state.winners        = null;
    this.state.lastAction     = null;
    this.state.handStartedAt  = Date.now();
    // Stale "what would have been" board from the previous hand has to clear
    // before fresh cards land — otherwise the iOS overlay would still offer
    // the previous hand's run-out reveal on the new hand's empty board.
    this.state.runOutBoard    = [];

    // Reset per-hand seat state.
    //
    // CRITICAL — chip-duplication bug fix (2026-05-09):
    // `betThisStreet` and `totalContributed` MUST be cleared for *every*
    // seat, not just the active ones. The previous version of this loop
    // only zeroed those fields inside the `stack > 0 && !SITTING_OUT`
    // branch, which meant a player who busted out the previous hand
    // (stack → 0, falls into the else branch) kept their stale
    // `totalContributed` from the hand they just lost. `buildClientView`
    // and `endHand` both compute pots via `buildPots(seats.map(...
    // totalContributed)))` over *all* seats — so that stale value showed
    // up as a phantom pot slice every subsequent hand, and `endHand`'s
    // `distributePots` credited it to the new winner. Chips appeared out
    // of nowhere round after round (user reported a leaked 4.6k pot
    // sticking across hands).
    //
    // Zero pot-tracking fields unconditionally. Card/blind state still
    // branches on whether the seat is actually playing this hand.
    for (const seat of this.state.seats) {
      seat.betThisStreet    = 0;
      seat.totalContributed = 0;
      seat.mucked           = [];
      seat.voluntaryShownCardIndices = [];

      if (seat.stack > 0 && seat.status !== 'SITTING_OUT') {
        seat.status       = 'ACTIVE';
        seat.holeCards    = [];
        seat.isDealer     = false;
        seat.isSmallBlind = false;
        seat.isBigBlind   = false;
      } else {
        seat.status = 'SITTING_OUT';
      }
    }

    // Advance dealer button
    const activeSeatIndices = this.state.seats
      .filter(s => s.status === 'ACTIVE')
      .map(s => s.seatIndex);

    this.state.dealerSeatIndex = this.nextSeatAfter(this.state.dealerSeatIndex, activeSeatIndices);

    // Assign blinds
    const sbIndex = this.nextSeatAfter(this.state.dealerSeatIndex, activeSeatIndices);
    const bbIndex = this.nextSeatAfter(sbIndex, activeSeatIndices);
    const sbSeat  = this.state.seats.find(s => s.seatIndex === sbIndex)!;
    const bbSeat  = this.state.seats.find(s => s.seatIndex === bbIndex)!;

    sbSeat.isDealer     = activeSeatIndices.length === 2; // heads-up: dealer = SB
    this.state.seats.find(s => s.seatIndex === this.state.dealerSeatIndex)!.isDealer = true;
    sbSeat.isSmallBlind = true;
    bbSeat.isBigBlind   = true;

    // Post blinds
    this.postBlind(sbSeat, this.state.smallBlind, 'SMALL_BLIND');
    this.postBlind(bbSeat, this.state.bigBlind,   'BIG_BLIND');

    // Deal hole cards
    this.state.deck = buildDeck();
    const activePlayers = this.state.seats.filter(s => s.status === 'ACTIVE' || s.status === 'ALL_IN');
    // Deal hole cards: 2 for Hold'em, 4 for PLO
    const cardsPerPlayer = this.state.gameType === 'PLO' ? 4 : 2;
    const dealOrder = this.getSeatOrderFrom(this.state.dealerSeatIndex, activePlayers.map(s => s.seatIndex));
    for (let round = 0; round < cardsPerPlayer; round++) {
      for (const seatIdx of dealOrder) {
        const seat = this.state.seats.find(s => s.seatIndex === seatIdx)!;
        seat.holeCards.push(this.state.deck.shift()!);
      }
    }

    this.state.phase = 'BETTING';

    // New hand: reset round-tracking state
    this.actedSinceLastBet      = new Set();
    this.voluntaryPreflopUserIds = new Set();
    this.lastAggressorId        = null;
    if (this.runoutTimer) { clearTimeout(this.runoutTimer); this.runoutTimer = null; }
    if (this.closeRoundTimer) { clearTimeout(this.closeRoundTimer); this.closeRoundTimer = null; }

    // First to act pre-flop is UTG (after BB)
    const utgIndex = this.nextSeatAfter(bbIndex, activeSeatIndices);
    this.setActivePlayer(utgIndex);

    logger.info(`Hand #${this.state.handNumber} started at table ${this.state.tableId}`);
    this.emit();
  }

  // ─── Player Action ──────────────────────────────────────────────────────────

  processAction(userId: string, action: ActionType, amount?: number): { ok: boolean; error?: string } {
    const seat = this.state.seats.find(s => s.userId === userId);
    if (!seat)                          return { ok: false, error: 'Not at this table' };
    if (this.state.activePlayerId !== userId) return { ok: false, error: 'Not your turn' };
    if (this.state.phase !== 'BETTING') return { ok: false, error: 'Not in betting phase' };

    const legal = this.getLegalActions(userId);
    const isLegal = legal.some(la => la.action === action);
    if (!isLegal) return { ok: false, error: `Action ${action} not legal here` };

    this.clearTurnTimer();

    // Snapshot currentBet so we can detect whether this action raised it.
    const priorBet = this.state.currentBet;

    switch (action) {
      case 'FOLD':   this.foldPlayer(userId); break;
      case 'CHECK':  this.checkPlayer(seat); break;
      case 'CALL':   this.callPlayer(seat); break;
      case 'RAISE':  { const r = this.raisePlayer(seat, amount!); if (!r.ok) return r; break; }
      case 'ALL_IN': this.allInPlayer(seat); break;
    }

    // Maintain actedSinceLastBet. A genuine bet/raise (currentBet increased)
    // resets the set — everyone else must act again. Otherwise the actor is
    // simply added. Folded players don't matter (they leave the active pool).
    if (this.state.currentBet > priorBet) {
      this.actedSinceLastBet.clear();
    }
    if (action !== 'FOLD') {
      this.actedSinceLastBet.add(userId);
    }

    // VPIP tracking — preflop CALL/RAISE/ALL_IN counts as voluntary money
    // in the pot. CHECK (BB walking through unraised) and FOLD do not count.
    // Posted blinds are auto-deducted, never go through processAction, so
    // they're correctly excluded here. The set is read at hand-end by
    // roomManager.persistHandResult to bump each user's vpipHands counter.
    if (this.state.street === 'PREFLOP'
        && (action === 'CALL' || action === 'RAISE' || action === 'ALL_IN')) {
      this.voluntaryPreflopUserIds.add(userId);
    }

    seat.lastActionAt = Date.now();
    this.state.lastAction = {
      playerId: userId,
      username: seat.username,
      action,
      amount: action === 'RAISE' ? amount : action === 'CALL' ? Math.min(this.state.currentBet - seat.betThisStreet + seat.betThisStreet, seat.stack) : undefined,
      timestamp: Date.now(),
    };

    // Decide whether this action will close the betting round (i.e. the
    // upcoming advanceGame() will route through advanceStreet, which zeros
    // every seat's betThisStreet). If so, freeze the active player BEFORE
    // emitting so the broadcast accurately reflects "no one's turn" — and
    // then schedule advanceGame() so the client gets a visible window to
    // animate the closing player's bet badge onto the felt before the next
    // emit clears every bet to feed the pot. See comment on
    // `closeRoundTimer` above for the underlying SwiftUI batching reason.
    const willCloseRound = this.willCloseBettingRound();
    if (willCloseRound) {
      this.state.activePlayerId = null;
      this.state.actionDeadline = 0;
    }

    this.emit();

    if (willCloseRound) {
      // If no seat has chips on the felt, the closing action was a check —
      // nothing to animate, so use the shorter delay so the next street
      // deals faster.
      const hasVisibleBets = this.state.seats.some(s => s.betThisStreet > 0);
      const delay = hasVisibleBets ? CLOSE_ROUND_DELAY_MS : CLOSE_ROUND_DELAY_NO_BETS_MS;
      if (this.closeRoundTimer) clearTimeout(this.closeRoundTimer);
      this.closeRoundTimer = setTimeout(() => {
        this.closeRoundTimer = null;
        this.advanceGame();
      }, delay);
    } else {
      this.advanceGame();
    }
    return { ok: true };
  }

  // Mirrors advanceGame's branch logic to predict whether the upcoming
  // advanceGame() call will collapse betThisStreet via advanceStreet — vs
  // simply moving to the next player (no bets cleared) or calling endHand
  // (which preserves betThisStreet through showdown). Used by processAction
  // to decide whether to delay advanceGame so the client can render the
  // closing action's chip arrival before bets vanish into the pot.
  private willCloseBettingRound(): boolean {
    const activePlayers = this.state.seats.filter(
      s => s.status === 'ACTIVE' || s.status === 'ALL_IN'
    );
    // endHand path — single contestant remaining (everyone else folded).
    // endHand doesn't zero betThisStreet, and is paced by HAND_START_DELAY,
    // so no extra delay is needed here.
    if (activePlayers.filter(s => s.status !== 'FOLDED').length === 1) {
      return false;
    }
    return this.isBettingRoundComplete();
  }

  // ─── Legal Actions ──────────────────────────────────────────────────────────

  getLegalActions(userId: string): LegalAction[] {
    const seat = this.state.seats.find(s => s.userId === userId);
    if (!seat || this.state.activePlayerId !== userId) return [];

    const toCall  = this.state.currentBet - seat.betThisStreet;
    const actions: LegalAction[] = [];

    actions.push({ action: 'FOLD' });

    if (toCall === 0) {
      actions.push({ action: 'CHECK' });
    } else {
      actions.push({ action: 'CALL', callAmount: Math.min(toCall, seat.stack) });
    }

    // Raise/All-in
    if (seat.stack > toCall) {
      const minRaise = this.state.currentBet + this.state.minRaise;
      let maxRaise = seat.stack + seat.betThisStreet;

      // Pot Limit for PLO: max raise = pot + call + call
      // Use `totalContributed` summed across all seats as the pot size — this
      // includes both prior-street chips AND the current betThisStreet. The
      // previous formula `totalPot(state.pots) + sum(betThisStreet)` was wrong
      // mid-hand because `state.pots` is only built at endHand and
      // betThisStreet is reset to 0 each new street. Result: postflop
      // potAfterCall computed as 0, so no RAISE was ever legal — the iOS
      // action bar collapsed to just All-In, matching the bug report.
      if (this.state.gameType === 'PLO') {
        const potCommitted = this.state.seats.reduce(
          (s, p) => s + p.totalContributed,
          0,
        );
        const potAfterCall = potCommitted + toCall;
        const potLimitMax  = potAfterCall + toCall + seat.betThisStreet;
        maxRaise = Math.min(maxRaise, potLimitMax);
      }

      if (maxRaise >= minRaise) {
        actions.push({ action: 'RAISE', minAmount: minRaise, maxAmount: maxRaise });
      }
    }

    // All-in is always available
    if (seat.stack > 0) {
      actions.push({ action: 'ALL_IN', maxAmount: seat.stack });
    }

    return actions;
  }

  // ─── Build client view ──────────────────────────────────────────────────────

  buildClientView(forUserId: string): ClientGameState {
    const pots  = buildPots(this.state.seats.map(s => ({
      playerId:         s.userId,
      totalContributed: s.totalContributed,
      isAllIn:          s.status === 'ALL_IN',
      isActive:         s.status !== 'FOLDED' && s.status !== 'SITTING_OUT',
    })));

    // ─── All-in showdown auto-reveal ──────────────────────────────────────────
    // When every player still in the hand is committed (no chips left to bet
    // by anyone, OR only one player has chips and everyone else is all-in),
    // there can be no further betting and cards turn face-up immediately —
    // the same way a live dealer announces "cards up" when nobody can act.
    // We check the live (non-folded, non-sitting-out) seats: if at most one
    // of them still has chips, all live hole cards are exposed regardless of
    // `phase` so the iOS client can render them face-up on every street.
    //
    // CRITICAL: also require `activePlayerId === null`. Without this guard,
    // an all-in bet on the river that puts the bettor's stack to 0 instantly
    // satisfies "≤1 player with chips" while the *opponent* still has the
    // action — and we'd send the bettor's hole cards to the opponent before
    // they even decide whether to call or fold. activePlayerId is only
    // cleared when the engine has finished routing action for the street
    // (advanceStreet, endHand), so gating on null ensures we only reveal
    // once the betting round is genuinely settled.
    const liveSeats = this.state.seats.filter(
      s => s.status === 'ACTIVE' || s.status === 'ALL_IN',
    );
    const liveSeatsWithChips = liveSeats.filter(s => s.stack > 0);
    const isAllInShowdown =
      liveSeats.length >= 2 &&
      liveSeatsWithChips.length <= 1 &&
      this.state.activePlayerId === null;

    // ─── Showdown reveal window ────────────────────────────────────────────────
    // `endHand` flips phase SHOWDOWN → ENDED synchronously before its single
    // emit(), so clients never observe phase==='SHOWDOWN' for a contested
    // hand. The reveal window is therefore phase==='ENDED' AND winners exist
    // AND at least one winner was flagged showCards (set from the `showdown`
    // param to endHand — true for river/all-in, false for fold-wins). This
    // keeps fold-wins muck-by-default while letting real showdowns flip up.
    const isContestedShowdown =
      this.state.phase === 'SHOWDOWN' ||
      (this.state.phase === 'ENDED'
        && (this.state.winners?.some(w => w.showCards) ?? false));

    const seats: ClientSeat[] = this.state.seats.map(s => {
      // Hole-card visibility rules:
      //   1. The seat's own user always sees their own cards.
      //   2. Other players see them at a real showdown — either phase
      //      ==='SHOWDOWN' (transient, currently unobserved by clients) or
      //      phase==='ENDED' with at least one winner.showCards flagged
      //      (the actual reveal window — see `isContestedShowdown` above).
      //   3. Fold-wins do NOT reveal cards. endHand(false) leaves
      //      winner.showCards=false so the ENDED branch above stays closed.
      //      The winner can voluntarily show via the show_cards event.
      //   4. All-in showdown (rule above) also reveals — same behaviour as a
      //      live dealer turning cards up when no further betting is possible.
      //   5. Folded players' holeCards are now stored in `mucked` (see
      //      `foldPlayer`); they no longer auto-reveal at SHOWDOWN, only via
      //      the voluntary `revealedCards` channel below.
      // For the seat's own user we always return their cards, but after a
      // fold the actual values now live in `mucked` (holeCards was cleared
      // to keep "is this player still in the hand" checks honest). Without
      // this branch the owner would see their own cards vanish on fold and
      // wouldn't be able to tap-to-show. Other viewers never see mucked.
      const ownerCards = s.status === 'FOLDED' ? s.mucked : s.holeCards;
      // Folded seats keep holeCards=null even during a contested-showdown
      // reveal window. Their actual cards live in `mucked`; emitting an
      // empty `s.holeCards: []` would also break the iOS `hasCards` check
      // (which falls back to `cardCount` only when holeCards is nil), so
      // the face-down cluster wouldn't render beside the folded avatar.
      const isFolded = s.status === 'FOLDED';
      const holeCards =
        s.userId === forUserId
          ? ownerCards
          : isFolded
            ? null
            : isContestedShowdown
              ? s.holeCards
              : isAllInShowdown
                ? s.holeCards
                : null;

      // ─── Voluntarily revealed cards (visible to everyone) ───────────────
      // The seat's owner has tapped specific card indices to expose. We look
      // them up in whichever array currently holds the cards: holeCards for
      // live seats, mucked for folded seats. Indices outside range are
      // dropped silently — show_cards validates them too, but defence in
      // depth is cheap.
      const sourceCards = s.status === 'FOLDED' ? s.mucked : s.holeCards;
      const revealedCards = s.voluntaryShownCardIndices
        .filter(i => i >= 0 && i < sourceCards.length)
        .map(i => ({ index: i, card: sourceCards[i] }));

      return {
        seatIndex:        s.seatIndex,
        userId:           s.userId,
        username:         s.username,
        displayName:      s.displayName,
        avatarId:         s.avatarId,
        stack:            s.stack,
        status:           s.status,
        holeCards,
        // Use mucked.length for folded players so opponents still see the
        // correct face-down placeholder count (2 for Holdem, 4 for PLO) — a
        // folded player whose cards have moved to `mucked` should still look
        // like they had a hand, otherwise the seat visually empties.
        cardCount:        s.status === 'FOLDED'
                            ? s.mucked.length
                            : s.holeCards.length,
        revealedCards,
        betThisStreet:    s.betThisStreet,
        totalContributed: s.totalContributed,
        isDealer:         s.isDealer,
        isSmallBlind:     s.isSmallBlind,
        isBigBlind:       s.isBigBlind,
        timeBank:         s.timeBank,
        isConnected:      s.isConnected,
        // Mid-hand leave indicator. iOS uses this to grey out the avatar
        // and overlay a "Left" badge so the rest of the table sees the
        // player has bailed even though their seat is still occupied
        // until endHand removes it.
        pendingLeave:     s.pendingLeave === true ? true : undefined,
        // Mid-hand top-up indicator. Omit when 0 to keep the wire payload
        // small (and to match the optional shape on the iOS Decodable
        // side, where `nil` is fine but `0` would still need handling).
        pendingTopUp:     s.pendingTopUp && s.pendingTopUp > 0
                            ? s.pendingTopUp
                            : undefined,
      };
    });

    // Total span of the active player's turn (base duration + their time bank).
    // Clients divide (deadline − now) by this to draw the timer ring correctly.
    const activeSeat = this.state.seats.find(s => s.userId === this.state.activePlayerId);
    const turnDuration = activeSeat
      ? TURN_DURATION_MS + activeSeat.timeBank * 1000
      : TURN_DURATION_MS;

    return {
      tableId:         this.state.tableId,
      gameType:        this.state.gameType,
      handNumber:      this.state.handNumber,
      phase:           this.state.phase,
      street:          this.state.street,
      seats,
      communityCards:  this.state.communityCards,
      pots:            this.state.pots.length > 0 ? this.state.pots : pots,
      totalPot:        totalPot(this.state.pots.length > 0 ? this.state.pots : pots),
      currentBet:      this.state.currentBet,
      minRaise:        this.state.minRaise,
      activePlayerId:  this.state.activePlayerId,
      dealerSeatIndex: this.state.dealerSeatIndex,
      smallBlind:      this.state.smallBlind,
      bigBlind:        this.state.bigBlind,
      actionDeadline:  this.state.actionDeadline,
      turnDuration,
      lastAction:      this.state.lastAction,
      winners:         this.state.winners,
      legalActions:    this.getLegalActions(forUserId),
      // Gate the would-have-been-board on phase=ENDED so a curious client
      // can't sniff future cards mid-hand by polling state. During live play
      // and the next hand's WAITING window, we always emit an empty array.
      revealableBoard: this.state.phase === 'ENDED' ? this.state.runOutBoard : [],
    };
  }

  // ─── Private: Action handlers ────────────────────────────────────────────────

  private foldPlayer(userId: string): void {
    const seat = this.state.seats.find(s => s.userId === userId);
    if (!seat) return;
    seat.status = 'FOLDED';
    // Move the cards aside instead of wiping them. `holeCards` going to []
    // preserves all the existing "is this player still in the hand" checks
    // that look at length — but `mucked` keeps the actual values around so
    // the player can voluntarily show one or both via the show_cards socket
    // event. `mucked` is cleared at the start of the next hand reset.
    seat.mucked = seat.holeCards;
    seat.holeCards = [];

    // Bot folded-hand reveal is deferred to `endHand` (see the bot-reveal
    // pass there). Setting `voluntaryShownCardIndices` here would leak the
    // folded bot's hole cards into every subsequent mid-hand broadcast —
    // fine in 1v1 where a bot fold ends the hand immediately, but wrong
    // at a multi-bot table where the hand continues with other contestants.
  }

  private checkPlayer(seat: Seat): void {
    // No chips move — valid only when toCall === 0
  }

  private callPlayer(seat: Seat): void {
    const toCall  = Math.min(this.state.currentBet - seat.betThisStreet, seat.stack);
    seat.stack           -= toCall;
    seat.betThisStreet   += toCall;
    seat.totalContributed += toCall;
    if (seat.stack === 0) seat.status = 'ALL_IN';
  }

  private raisePlayer(seat: Seat, totalBet: number): { ok: boolean; error?: string } {
    // ─── Input sanitization ──────────────────────────────────────────────
    // The `totalBet` value originates from a client websocket payload. We
    // can't trust the type — TypeScript's non-null assertion at the call
    // site only suppresses a compile-time warning, it does not enforce
    // anything at runtime. A malicious or buggy client can send `undefined`
    // (no `amount` field), a string ("100"), `NaN`, `Infinity`, or a
    // negative value. Without this guard, any of those would slip past the
    // existing min-bet check (NaN/undefined comparisons all evaluate
    // `false`) and reach the arithmetic below, where `seat.stack -= NaN`
    // permanently corrupts the seat with NaN values that propagate through
    // pot calculations and break the table until it's destroyed.
    if (!Number.isInteger(totalBet) || totalBet <= 0) {
      return { ok: false, error: 'Invalid raise amount' };
    }

    // ─── Upper bound: phantom-raise prevention ───────────────────────────
    // The previous implementation only checked `totalBet >= minBet`. There
    // was no upper bound, so a client could claim a `totalBet` of, say,
    // 999_999_999 with a real stack of 1000. The chips actually deducted
    // were correctly clamped (`Math.min(totalBet - betThisStreet, stack)`),
    // so no chips were stolen — but `currentBet`, `betThisStreet`, and
    // `minRaise` were all set to the unclamped value. Effect: every other
    // player at the table sees a billion-chip bet they have to either fold
    // or be put all-in to call, while the attacker only committed their
    // real stack. UI integrity exploit, not a chip-theft exploit, but
    // game-breaking. Enforcing the same `seat.stack + seat.betThisStreet`
    // ceiling that `getLegalActions` advertises closes the hole.
    const maxBet = seat.stack + seat.betThisStreet;
    if (totalBet > maxBet) {
      return { ok: false, error: `Raise cannot exceed ${maxBet}` };
    }

    // ─── PLO pot-limit cap ───────────────────────────────────────────────
    // For PLO, `getLegalActions` advertises a tighter `maxAmount` derived
    // from the pot-limit formula. We re-derive it here on the server so the
    // canonical bound is enforced even if a client chooses to ignore the
    // hint. Mirrors the calculation in `getLegalActions` line ~305.
    if (this.state.gameType === 'PLO') {
      const toCall = this.state.currentBet - seat.betThisStreet;
      // Mirror the corrected formula in getLegalActions — totalContributed
      // sum is the true pot size mid-hand (state.pots only fills at endHand).
      const potCommitted = this.state.seats.reduce(
        (s, p) => s + p.totalContributed,
        0,
      );
      const potAfterCall = potCommitted + toCall;
      const potLimitMax  = potAfterCall + toCall + seat.betThisStreet;
      if (totalBet > potLimitMax) {
        return { ok: false, error: `PLO raise cannot exceed pot limit ${potLimitMax}` };
      }
    }

    const minBet = this.state.currentBet + this.state.minRaise;
    if (totalBet < minBet && totalBet !== seat.stack + seat.betThisStreet) {
      return { ok: false, error: `Raise must be at least ${minBet}` };
    }
    const chips = Math.min(totalBet - seat.betThisStreet, seat.stack);
    const raiseDiff       = totalBet - this.state.currentBet;
    this.state.minRaise   = raiseDiff;
    this.state.currentBet = totalBet;
    seat.stack           -= chips;
    seat.betThisStreet    = totalBet;
    seat.totalContributed += chips;
    if (seat.stack === 0) seat.status = 'ALL_IN';
    // Track this player as the aggressor so all others must act again
    this.lastAggressorId = seat.userId;
    return { ok: true };
  }

  private allInPlayer(seat: Seat): void {
    const chips = seat.stack;
    seat.totalContributed += chips;
    seat.betThisStreet    += chips;
    seat.stack             = 0;
    seat.status            = 'ALL_IN';
    if (seat.betThisStreet > this.state.currentBet) {
      this.state.minRaise   = seat.betThisStreet - this.state.currentBet;
      this.state.currentBet = seat.betThisStreet;
      // Counts as a raise — all other active players must act again
      this.lastAggressorId = seat.userId;
    }
  }

  private postBlind(seat: Seat, amount: number, type: 'SMALL_BLIND' | 'BIG_BLIND'): void {
    const chips = Math.min(amount, seat.stack);
    seat.stack           -= chips;
    seat.betThisStreet   += chips;
    seat.totalContributed += chips;
    if (seat.stack === 0) seat.status = 'ALL_IN';
    this.state.lastAction = { playerId: seat.userId, username: seat.username, action: type, amount: chips, timestamp: Date.now() };
  }

  // ─── Private: Game flow ──────────────────────────────────────────────────────

  private advanceGame(): void {
    const activePlayers = this.state.seats.filter(s => s.status === 'ACTIVE' || s.status === 'ALL_IN');
    const bettingPlayers = this.state.seats.filter(s => s.status === 'ACTIVE');

    // If only one player left (everyone else folded) → end hand.
    //
    // We can't `endHand` synchronously when there are still visible bets in
    // front of seats (e.g. someone called a bet then the next-to-act folded,
    // leaving SB/BB or call chips parked in front of the remaining seats).
    // `endHand` builds pots from `totalContributed` and broadcasts the
    // winner+pot animation, but it does NOT zero `betThisStreet` — those
    // values stay until `startHand` clears them at the next deal. The iOS
    // client therefore sees: bet badges sit through the winner banner, then
    // disappear with no transition target when the next hand emits with
    // bets=0 (the pot has already moved to the winner). Visually: chips in
    // front of seats vanish instead of flying to the pot.
    //
    // Fix: emit a bet-zeroing state first so the client gets to play its
    // existing bet-removal transition (chips → pot), wait `CLOSE_ROUND_DELAY_MS`
    // for that animation to land, then run `endHand` for the winner reveal.
    // Mirrors the close-round delay used in `processAction` for street
    // advances. Pot value is unaffected (built from `totalContributed`).
    // Showdown / all-in paths are unaffected because `advanceStreet` already
    // zeros bets before reaching this branch on the river.
    if (activePlayers.filter(s => s.status !== 'FOLDED').length === 1) {
      const hasVisibleBets = this.state.seats.some(s => s.betThisStreet > 0);
      if (hasVisibleBets) {
        for (const s of this.state.seats) s.betThisStreet = 0;
        this.state.currentBet = 0;
        this.state.activePlayerId = null;
        this.state.actionDeadline = 0;
        this.emit();
        if (this.closeRoundTimer) clearTimeout(this.closeRoundTimer);
        this.closeRoundTimer = setTimeout(() => {
          this.closeRoundTimer = null;
          this.endHand(false);
        }, CLOSE_ROUND_DELAY_MS);
        return;
      }
      this.endHand(false);
      return;
    }

    // Check if betting round is complete
    if (this.isBettingRoundComplete()) {
      this.advanceStreet();
    } else {
      // Next player to act
      this.moveToNextPlayer();
    }
  }

  private isBettingRoundComplete(): boolean {
    // If only one contestant remains (everyone else folded) hand is over.
    const contested = this.state.seats.filter(
      s => s.status === 'ACTIVE' || s.status === 'ALL_IN'
    );
    if (contested.length <= 1) return true;

    // Every ACTIVE (non-all-in) player must have matched the current bet AND
    // acted since the last bet/raise. If there are no active players left
    // (everyone still in the hand is all-in), the round is trivially complete.
    const active = this.state.seats.filter(s => s.status === 'ACTIVE');
    if (active.length === 0) return true;

    for (const s of active) {
      if (s.betThisStreet !== this.state.currentBet) return false;
      if (!this.actedSinceLastBet.has(s.userId))      return false;
    }
    return true;
  }

  private dealStreetCards(street: Street): void {
    switch (street) {
      case 'FLOP':
        this.state.deck.shift(); // burn
        this.state.communityCards.push(this.state.deck.shift()!);
        this.state.communityCards.push(this.state.deck.shift()!);
        this.state.communityCards.push(this.state.deck.shift()!);
        break;
      case 'TURN':
      case 'RIVER':
        this.state.deck.shift(); // burn
        this.state.communityCards.push(this.state.deck.shift()!);
        break;
    }
  }

  // Returns the cards that *would have been* dealt to fill the rest of the
  // board, without touching the deck. Caller is responsible for only invoking
  // this when the hand ends before the river — during live play the deck is
  // already mid-deal and a "run-out" preview makes no sense. We mirror the
  // exact burn pattern dealStreetCards uses (1 burn before the flop trio, 1
  // before the turn, 1 before the river) so the cards we expose match what a
  // real run-out would have produced if the hand continued.
  private peekRunOutBoard(): Card[] {
    const dealt = this.state.communityCards.length;
    if (dealt >= 5) return [];

    const result: Card[] = [];
    let cursor = 0;
    const take = (n: number): void => {
      for (let k = 0; k < n; k++) {
        const card = this.state.deck[cursor++];
        if (card) result.push(card);
      }
    };
    const burn = (): void => { cursor++; };

    if (dealt === 0) {
      // Preflop fold — show would-be flop, turn, and river
      burn(); take(3);
      burn(); take(1);
      burn(); take(1);
    } else if (dealt === 3) {
      // Flop fold — show would-be turn + river
      burn(); take(1);
      burn(); take(1);
    } else if (dealt === 4) {
      // Turn fold — show would-be river
      burn(); take(1);
    }
    return result;
  }

  private advanceStreet(): void {
    // Reset per-street bets and round-tracking state
    for (const seat of this.state.seats) {
      seat.betThisStreet = 0;
    }
    this.state.currentBet = 0;
    this.state.minRaise   = this.state.bigBlind;
    this.lastAggressorId  = null;
    this.actedSinceLastBet.clear();

    const streets: Street[] = ['PREFLOP', 'FLOP', 'TURN', 'RIVER', 'SHOWDOWN'];
    const nextStreetIdx = streets.indexOf(this.state.street) + 1;

    if (nextStreetIdx >= streets.length) {
      this.endHand(true);
      return;
    }

    this.state.street = streets[nextStreetIdx];

    if (this.state.street === 'SHOWDOWN') {
      this.endHand(true);
      return;
    }

    // Deal this street's community cards and show the new board to clients
    // BEFORE deciding what happens next.
    this.dealStreetCards(this.state.street);
    this.state.activePlayerId = null;
    this.state.actionDeadline = 0;
    this.emit();

    // All-in runout: no further betting possible (at most one player can still
    // act, but they have nobody to bet against). Schedule the remaining streets
    // to deal one at a time with a visible delay so clients actually see the
    // turn and river land before showdown.
    if (this.allPlayersAllIn()) {
      if (this.runoutTimer) clearTimeout(this.runoutTimer);
      this.runoutTimer = setTimeout(() => {
        this.runoutTimer = null;
        if (this.state.street === 'RIVER') {
          this.endHand(true);
        } else {
          this.advanceStreet();
        }
      }, 1500);
      return;
    }

    // Normal post-flop action: first active player left of dealer
    const active = this.state.seats
      .filter(s => s.status === 'ACTIVE')
      .map(s => s.seatIndex);
    if (active.length === 0) {
      // No one left to act (shouldn't happen after allPlayersAllIn check, but guard)
      if (this.runoutTimer) clearTimeout(this.runoutTimer);
      this.runoutTimer = setTimeout(() => {
        this.runoutTimer = null;
        if (this.state.street === 'RIVER') this.endHand(true);
        else this.advanceStreet();
      }, 1500);
      return;
    }
    const firstAct = this.nextSeatAfter(this.state.dealerSeatIndex, active);
    this.setActivePlayer(firstAct);
    this.emit();
  }

  private allPlayersAllIn(): boolean {
    const contested = this.state.seats.filter(s => s.status === 'ACTIVE' || s.status === 'ALL_IN');
    return contested.filter(s => s.status === 'ACTIVE').length <= 1;
  }

  private moveToNextPlayer(): void {
    const active = this.state.seats
      .filter(s => s.status === 'ACTIVE')
      .map(s => s.seatIndex);
    if (active.length === 0) { this.advanceStreet(); return; }

    const currentIdx   = this.state.seats.find(s => s.userId === this.state.activePlayerId)?.seatIndex ?? -1;
    const nextSeatIdx  = this.nextSeatAfter(currentIdx, active);
    this.setActivePlayer(nextSeatIdx);
    this.emit();
  }

  private setActivePlayer(seatIndex: number): void {
    const seat = this.state.seats.find(s => s.seatIndex === seatIndex);
    if (!seat) { this.endHand(true); return; }
    this.state.activePlayerId  = seat.userId;
    this.state.actionDeadline  = Date.now() + TURN_DURATION_MS + seat.timeBank * 1000;
    // New turn → new extension allowance for everybody. The set is keyed by
    // userId so it survives seat reshuffles within a hand.
    this.extensionUsedThisTurn.clear();
    this.startTurnTimer(seat);

    // Auto-act for bot players after a short "thinking" delay.
    // At a multi-bot table, identical Math.random() distributions would
    // sometimes cluster two bots' actions into the same ~150ms window
    // (visually they'd "double-act"). The per-bot hashed offset (0–599ms,
    // stable by userId) staggers them deterministically without dropping
    // the base randomness — humans still see varied think times.
    if (seat.isBot) {
      const baseDelay    = 1200 + Math.random() * 1800; // 1.2–3s
      const perBotOffset = hashStringToInt(seat.userId) % 600;
      const delay        = baseDelay + perBotOffset;
      setTimeout(() => this.processBotAction(seat.userId), delay);
    }
  }

  // ─── Bot decision making ────────────────────────────────────────────────────
  //
  // The bot now actually reads its own cards. A normalized "strength" value
  // in [0, 1] is derived from either a Chen-style preflop score or (postflop)
  // from the rank/tiebreakers of the best 5-card hand over the community
  // board. Strength buckets map to an action profile:
  //
  //   ≥ 0.80  monster   — value-raise pot / shove; rarely fold to anything
  //   ≥ 0.60  strong    — raise ~¾ pot or 2–3× facing a bet; never fold
  //   ≥ 0.42  decent    — call most bets, occasional raise; fold big bets
  //   ≥ 0.25  marginal  — call cheap, fold expensive, sometimes check-raise
  //   else    trash     — check/fold; occasional small bluff
  //
  // Raise sizing respects legal min/max and targets a pot-relative amount so
  // the bot no longer always min-raises.
  private processBotAction(userId: string): void {
    if (this.state.activePlayerId !== userId) return; // turn changed
    const seat = this.state.seats.find(s => s.userId === userId);
    if (!seat) return;
    const legal = this.getLegalActions(userId);
    if (!legal.length) return;

    const checkAct = legal.find(a => a.action === 'CHECK');
    const callAct  = legal.find(a => a.action === 'CALL');
    const raiseAct = legal.find(a => a.action === 'RAISE');

    const rand      = Math.random();
    const toCall    = callAct?.callAmount ?? 0;
    const stackFrac = seat.stack > 0 ? toCall / seat.stack : 1;
    const pot       = this.state.seats.reduce((sum, s) => sum + s.totalContributed, 0);
    const street    = this.state.street;
    const strength  = this.botHandStrength(seat.holeCards, this.state.communityCards, street);

    // Helper: fire a RAISE to a pot-relative target, clamped to legal bounds.
    // `potFrac` is fraction of current pot to add on top of the current bet.
    const raiseTo = (potFrac: number): number | null => {
      if (!raiseAct || raiseAct.minAmount == null || raiseAct.maxAmount == null) return null;
      const target = Math.round(this.state.currentBet + Math.max(pot, this.state.bigBlind * 3) * potFrac);
      return Math.max(raiseAct.minAmount, Math.min(raiseAct.maxAmount, target));
    };

    // ── Case A: no bet to call — we can check or open a bet ──────────────────
    if (checkAct) {
      if (strength >= 0.80 && raiseAct) {
        // Monster — bet ~90% pot for value
        const amt = raiseTo(0.9)!;
        this.processAction(userId, 'RAISE', amt); return;
      }
      if (strength >= 0.60 && raiseAct && rand < 0.85) {
        const amt = raiseTo(0.65)!;
        this.processAction(userId, 'RAISE', amt); return;
      }
      if (strength >= 0.42 && raiseAct && rand < 0.55) {
        const amt = raiseTo(0.45)!;
        this.processAction(userId, 'RAISE', amt); return;
      }
      if (strength >= 0.25 && raiseAct && rand < 0.20) {
        // Semi-bluff / probe bet
        const amt = raiseTo(0.35)!;
        this.processAction(userId, 'RAISE', amt); return;
      }
      if (strength < 0.25 && raiseAct && rand < 0.08) {
        // Occasional pure bluff
        const amt = raiseTo(0.5)!;
        this.processAction(userId, 'RAISE', amt); return;
      }
      this.processAction(userId, 'CHECK'); return;
    }

    // ── Case B: facing a bet — call / raise / fold ───────────────────────────
    if (callAct) {
      // Monster: raise big or slow-play occasionally
      if (strength >= 0.80) {
        if (raiseAct && rand < 0.80) {
          const amt = raiseTo(0.9)!;
          this.processAction(userId, 'RAISE', amt); return;
        }
        this.processAction(userId, 'CALL'); return;
      }

      // Strong: raise more often than call, never fold
      if (strength >= 0.60) {
        if (raiseAct && rand < 0.55) {
          const amt = raiseTo(0.7)!;
          this.processAction(userId, 'RAISE', amt); return;
        }
        this.processAction(userId, 'CALL'); return;
      }

      // Decent: mostly call, occasionally raise, fold to huge bets
      if (strength >= 0.42) {
        if (stackFrac >= 0.55 && rand < 0.45) {
          this.processAction(userId, 'FOLD'); return;
        }
        if (raiseAct && rand < 0.18) {
          const amt = raiseTo(0.5)!;
          this.processAction(userId, 'RAISE', amt); return;
        }
        this.processAction(userId, 'CALL'); return;
      }

      // Marginal: call cheap bets, fold expensive, rare bluff-raise
      if (strength >= 0.25) {
        if (stackFrac >= 0.35) {
          if (rand < 0.80) { this.processAction(userId, 'FOLD'); return; }
          this.processAction(userId, 'CALL'); return;
        }
        if (raiseAct && rand < 0.08) {
          this.processAction(userId, 'RAISE', raiseAct.minAmount!); return;
        }
        if (rand < 0.55) {
          this.processAction(userId, 'CALL'); return;
        }
        this.processAction(userId, 'FOLD'); return;
      }

      // Trash: fold nearly always, tiny bluff rate
      if (raiseAct && rand < 0.04 && stackFrac < 0.15) {
        const amt = raiseTo(0.6)!;
        this.processAction(userId, 'RAISE', amt); return;
      }
      if (stackFrac < 0.05 && rand < 0.40) {
        // Almost free to see a card — call
        this.processAction(userId, 'CALL'); return;
      }
      this.processAction(userId, 'FOLD'); return;
    }

    // ── Case C: nothing but fold / all-in legal ──────────────────────────────
    this.processAction(userId, 'FOLD');
  }

  // Returns a strength value in [0, 1] for the bot's current holdings.
  // Preflop uses a Chen-style score; postflop uses the best-hand evaluator.
  private botHandStrength(hole: Card[], board: Card[], street: Street): number {
    if (!hole || hole.length < 2) return 0.3;

    // ── Preflop: Chen-style score, normalized to [0, 1] ──────────────────────
    if (street === 'PREFLOP' || board.length === 0) {
      const [a, b] = hole;
      const va = RANK_VALUE[a.rank];
      const vb = RANK_VALUE[b.rank];
      const hi = Math.max(va, vb);
      const lo = Math.min(va, vb);

      // Base score — pairs are the highest preflop equities
      let score: number;
      if (va === vb) {
        // Pocket pair: AA=20, KK=16, QQ=14, JJ=12, TT=10, 99=9, ...
        const highVal = (() => {
          if (hi === 14) return 20;        // AA
          if (hi === 13) return 16;        // KK
          if (hi === 12) return 14;        // QQ
          if (hi === 11) return 12;        // JJ
          return Math.max(5, hi);          // TT down
        })();
        score = highVal;
      } else {
        // High-card value: A=10, K=8, Q=7, J=6, else rank/2
        const highVal = (() => {
          if (hi === 14) return 10;
          if (hi === 13) return 8;
          if (hi === 12) return 7;
          if (hi === 11) return 6;
          return hi / 2;
        })();
        score = highVal;
        if (a.suit === b.suit) score += 2;           // suited bonus
        const gap = hi - lo - 1;                     // 0 = connected
        if      (gap === 0) score += 1;
        else if (gap === 1) score += 0;
        else if (gap === 2) score -= 1;
        else if (gap === 3) score -= 2;
        else                score -= 4;
        // Small bonus for both cards ≥ T
        if (lo >= 10) score += 1;
      }

      // Normalize: Chen range is roughly [-2, 20] → clamp into [0, 1]
      const normalized = Math.max(0, Math.min(1, (score + 2) / 22));
      // Compress the top so 77-TT aren't treated as monsters preflop
      return 0.1 + normalized * 0.75;
    }

    // ── Postflop: evaluate best 5-card hand over (hole + board) ──────────────
    try {
      const evaluated = this.state.gameType === 'PLO' && board.length >= 3
        ? evaluatePLOHand(hole, board)
        : evaluateHand([...hole, ...board]);
      const rank = evaluated.rank;
      const topKicker = evaluated.tiebreakers[0] ?? 0;

      // Normalized base per rank
      let base: number;
      switch (rank) {
        case HandRank.HIGH_CARD:       base = 0.15; break;
        case HandRank.ONE_PAIR:        base = 0.38; break;
        case HandRank.TWO_PAIR:        base = 0.58; break;
        case HandRank.THREE_OF_A_KIND: base = 0.72; break;
        case HandRank.STRAIGHT:        base = 0.80; break;
        case HandRank.FLUSH:           base = 0.85; break;
        case HandRank.FULL_HOUSE:      base = 0.92; break;
        case HandRank.FOUR_OF_A_KIND:  base = 0.97; break;
        case HandRank.STRAIGHT_FLUSH:  base = 0.99; break;
        case HandRank.ROYAL_FLUSH:     base = 1.00; break;
        default:                       base = 0.20; break;
      }

      // Kicker nudge — better kicker slightly bumps weak hands up
      const kickerBonus = Math.min(0.08, Math.max(0, (topKicker - 7) * 0.01));

      // Pair tier adjustment: low pair < 0.38, high pair > 0.38
      let adj = 0;
      if (rank === HandRank.ONE_PAIR) {
        // topKicker here is the pair rank
        if (topKicker >= 13) adj = 0.10;        // KK+
        else if (topKicker >= 11) adj = 0.06;   // JJ+
        else if (topKicker >= 9)  adj = 0.02;
        else                      adj = -0.05;
      }
      if (rank === HandRank.TWO_PAIR && topKicker >= 10) adj = 0.04;

      return Math.max(0, Math.min(1, base + adj + kickerBonus));
    } catch {
      return 0.3;
    }
  }

  private startTurnTimer(seat: Seat): void {
    this.clearTurnTimer();
    const deadline = this.state.actionDeadline;
    const delay    = deadline - Date.now();
    this.turnTimer = setTimeout(() => {
      // On timeout we prefer auto-CHECK over auto-FOLD when checking is
      // legal (i.e. nothing to call — BB walking through an unraised pot,
      // or any spot where seat has already matched currentBet). Folding
      // a free check would burn the player's equity for no reason. Only
      // bail out (fold) when there's an outstanding bet they'd have to
      // pay to stay in.
      const canCheck = seat.betThisStreet >= this.state.currentBet;
      const action: 'CHECK' | 'FOLD' = canCheck ? 'CHECK' : 'FOLD';
      logger.info(`Auto-${action.toLowerCase()}: ${seat.username} timed out in hand #${this.state.handNumber}`);
      this.processAction(seat.userId, action);
    }, Math.max(delay, 0));
  }

  private clearTurnTimer(): void {
    if (this.turnTimer) { clearTimeout(this.turnTimer); this.turnTimer = null; }
  }

  // ─── Time Extension (one per turn per player) ───────────────────────────────
  //
  // Public: socket handler calls this when a player taps the +15s pill.
  // Returns true iff the deadline was actually bumped (caller can choose to
  // emit state on success). Gated on:
  //   1. it's actually this user's turn (no one can extend during a hand
  //      they're not active in),
  //   2. they haven't already extended on this turn,
  //   3. the hand is in a betting phase with a live deadline.
  // The 1-per-turn cap exists so a stalling opponent can't repeatedly buy
  // themselves another 15 seconds.
  requestTimeExtension(userId: string): boolean {
    if (this.state.activePlayerId !== userId) return false;
    if (this.extensionUsedThisTurn.has(userId)) return false;
    if (!this.state.actionDeadline) return false;
    const seat = this.state.seats.find(s => s.userId === userId);
    if (!seat) return false;

    this.state.actionDeadline += TIME_EXTENSION_MS;
    this.extensionUsedThisTurn.add(userId);
    // Restart the auto-fold timer against the new (later) deadline.
    this.startTurnTimer(seat);
    return true;
  }

  // ─── End Hand ────────────────────────────────────────────────────────────────

  private endHand(showdown: boolean): void {
    this.clearTurnTimer();
    this.state.phase = 'SHOWDOWN';
    this.state.activePlayerId = null;

    // Bot folded-hand reveal — runs once per hand, here at hand-end, instead
    // of inside `foldPlayer` where it used to fire on the fold action itself.
    // The old placement leaked mid-hand cards at multi-bot tables (a bot
    // folding preflop with 3 other contestants still in the pot would expose
    // its hole cards through the remaining streets). Doing it at hand-end
    // keeps the 1v1 "bot folds → hand ends → cards revealed" UX intact
    // (this block runs in the same emit as the winners payload, so the
    // reveal is atomic with the BIFF! winner beat) while preserving fairness
    // when the hand continues with other players.
    //
    // Humans are intentionally excluded: folded humans keep their privacy.
    // Showdown reveal is a different path (winners[].showCards) and not
    // affected by `voluntaryShownCardIndices`.
    for (const s of this.state.seats) {
      if (s.isBot && s.status === 'FOLDED' && s.mucked.length > 0) {
        s.voluntaryShownCardIndices = s.mucked.map((_, i) => i);
      }
    }

    // Build final pots
    this.state.pots = buildPots(this.state.seats.map(s => ({
      playerId:         s.userId,
      totalContributed: s.totalContributed,
      isAllIn:          s.status === 'ALL_IN',
      isActive:         s.status !== 'FOLDED' && s.status !== 'SITTING_OUT',
    })));

    const contestants = this.state.seats.filter(
      s => s.status === 'ACTIVE' || s.status === 'ALL_IN'
    );

    let winners: WinnerPayout[] = [];

    if (contestants.length === 1) {
      // Everyone folded → uncontested. Surface the would-have-been board so
      // the iOS layer can render face-down "tap to reveal" placeholders for
      // the remaining streets. Only meaningful here — a contested showdown
      // by definition reached the river (or got there via the all-in
      // runout), so the board is already complete in those branches.
      if (this.state.communityCards.length < 5) {
        this.state.runOutBoard = this.peekRunOutBoard();
      }
      const winner = contestants[0];
      const amount = totalPot(this.state.pots);
      winner.stack += amount;
      winners = [{
        playerId:  winner.userId,
        username:  winner.username,
        amount,
        handName:  'Uncontested',
        bestCards: [],
        showCards: false,
      }];
    } else {
      // Evaluate hands and distribute pots
      const handResults: PlayerHandResult[] = contestants.map(s => ({
        playerId: s.userId,
        holeCards: s.holeCards,
        hand: this.state.gameType === 'PLO'
          ? evaluatePLOHand(s.holeCards, this.state.communityCards)
          : evaluateHand([...s.holeCards, ...this.state.communityCards]),
      }));

      // Per-pot winners
      const winnersByPot = new Map<number, string[]>();
      for (let i = 0; i < this.state.pots.length; i++) {
        const pot         = this.state.pots[i];
        const eligible    = handResults.filter(r => pot.eligiblePlayerIds.includes(r.playerId));
        const { winners: w } = determineWinners(eligible);
        winnersByPot.set(i, w);
      }

      const payouts = distributePots(this.state.pots, winnersByPot);

      for (const payout of payouts) {
        const seat = this.state.seats.find(s => s.userId === payout.playerId);
        if (seat) seat.stack += payout.amount;
      }

      const bestHand = handResults.reduce((best, r) =>
        !best || r.hand.rank > best.hand.rank ? r : best, handResults[0]
      );

      winners = payouts.map(p => {
        const result = handResults.find(r => r.playerId === p.playerId);
        return {
          playerId:  p.playerId,
          username:  this.state.seats.find(s => s.userId === p.playerId)?.username ?? '',
          amount:    p.amount,
          handName:  result?.hand.name ?? 'Uncontested',
          bestCards: result?.hand.bestCards ?? [],
          showCards: showdown,
        };
      });
    }

    this.state.winners = winners;
    this.state.phase   = 'ENDED';
    // Diagnostic for the split-pot Full-House-vs-Two-Pair report (2026-05-13).
    // Backend repro of the exact reported cards (A♣K♣3♥2♣ vs 5♣8♦J♣J♥ on
    // 6♥K♥K♠2♠Q♦) returned a sole winner correctly, so a real split being
    // emitted would mean the live hole cards or board differed from the
    // screenshot. Logging the authoritative winners structure here makes the
    // next occurrence either match the screenshot (real backend bug) or
    // contradict it (iOS rendering bug). Remove once the report is closed.
    logger.info(`Hand #${this.state.handNumber} showdown winners: ${JSON.stringify(winners.map(w => ({
      playerId:  w.playerId,
      handName:  w.handName,
      amount:    w.amount,
      bestCards: w.bestCards.map(c => `${c.rank}${c.suit}`),
    })))} | board: ${this.state.communityCards.map(c => `${c.rank}${c.suit}`).join(',')} | holes: ${JSON.stringify(this.state.seats
      .filter(s => s.status === 'ACTIVE' || s.status === 'ALL_IN')
      .map(s => ({ userId: s.userId, cards: s.holeCards.map(c => `${c.rank}${c.suit}`) })))}`);
    this.emit();
    this.onHandEnd(this.state);

    // Remove busted players (stack = 0) and schedule next hand
    setTimeout(() => {
      // Evict players who tapped "leave" mid-hand. We hold their seat
      // until now so action ordering, dealer/blind tracking, and any
      // all-in showdown rights stay intact. With the hand over, they
      // can be safely spliced out — their seat re-opens for someone
      // else to join, and `nextSeatAfter` (used by startHand to advance
      // the dealer button + blinds) automatically routes around the
      // missing seatIndex because it walks the remaining activeSeats
      // sorted by index. No need to renormalize seatIndex values.
      this.state.seats = this.state.seats.filter(s => !s.pendingLeave);

      // Drain any mid-hand top-ups first so the bust-vs-WAITING decision
      // below uses the post-top-up stack. Without this, a player who
      // bought chips during the hand they just busted would be flagged
      // SITTING_OUT for the next hand and have to manually wake up.
      this.applyPendingTopUps();

      for (const seat of this.state.seats) {
        if (seat.stack === 0) seat.status = 'SITTING_OUT';
        else seat.status = 'WAITING';
        // Belt-and-suspenders pot reset: the authoritative reset happens
        // in startHand, but startHand doesn't fire until canStartHand()
        // is true — which can be never (one player at the table, table
        // closing, etc.). Clearing here means the WAITING-phase emit
        // below broadcasts a clean 0 pot instead of carrying the
        // previous hand's totalContributed forward into the next
        // buildClientView fallback at gameEngine.ts:658-659.
        seat.betThisStreet    = 0;
        seat.totalContributed = 0;
      }
      // Drop the snapshot of the prior hand's pot slices; without this
      // `buildClientView`'s `state.pots.length > 0 ? state.pots : pots`
      // ternary keeps emitting the dead pot until startHand wipes it.
      this.state.pots    = [];
      this.state.phase   = 'WAITING';
      this.state.winners = null;
      this.emit();
      if (this.canStartHand()) this.startHand();
    }, HAND_START_DELAY);
  }

  // ─── Utilities ────────────────────────────────────────────────────────────────

  private nextSeatAfter(currentSeat: number, seatIndices: number[]): number {
    if (seatIndices.length === 0) return -1;
    const sorted = [...seatIndices].sort((a, b) => a - b);
    const next   = sorted.find(i => i > currentSeat);
    return next !== undefined ? next : sorted[0];
  }

  private getSeatOrderFrom(startSeat: number, seatIndices: number[]): number[] {
    const sorted = [...seatIndices].sort((a, b) => a - b);
    const startIdx = sorted.findIndex(i => i > startSeat);
    if (startIdx === -1) return sorted;
    return [...sorted.slice(startIdx), ...sorted.slice(0, startIdx)];
  }

  private emit(): void {
    this.onStateChange(this.state);
  }
}
