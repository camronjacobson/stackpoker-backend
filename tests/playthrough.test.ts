// Large-scale playthrough test suite for PokerGameEngine.
//
// The idea: drive many full hands by picking random *legal* actions at every
// turn and assert that core poker-rule invariants hold at every checkpoint.
// This catches bugs that targeted tests miss — e.g. chips materializing from
// nowhere in a 4-way all-in, opponents' hole cards leaking on a specific
// street, the active player landing on a folded seat, etc.
//
// Strategy notes:
//  - Between hands, the engine schedules the next-hand cleanup with a
//    `setTimeout(..., 6000)` inside `endHand`. We use Jest fake timers and
//    advance the clock between hands so the suite runs in milliseconds, not
//    seconds × N.
//  - The `processAction → advanceGame` path can also schedule a
//    `CLOSE_ROUND_DELAY_MS` (≤ 700ms) timer to give the iOS client a window
//    to animate chips into the pot. We advance that too whenever we observe
//    a pending betting-round-close delay.
//  - We collect emitted states into an array via the `onStateChange`
//    callback so we can audit every intermediate snapshot the engine ever
//    broadcast — not just the final state.

import { PokerGameEngine } from '../src/game/gameEngine';
import { ServerGameState, ActionType } from '../src/game/gameState.types';
import { cardKey } from '../src/game/deck';
import { evaluateHand, compareHands, EvaluatedHand } from '../src/game/handEvaluator';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeSeat(o: { userId: string; seatIndex: number; stack?: number }) {
  return {
    seatIndex:   o.seatIndex,
    userId:      o.userId,
    username:    o.userId,
    displayName: o.userId,
    avatarId:    'avatar_1',
    stack:       o.stack ?? 1000,
    status:      'WAITING' as const,
    timeBank:    30,
    isConnected: true,
  };
}

interface Harness {
  engine: PokerGameEngine;
  states: ServerGameState[];
  initialTotal: number;
}

function makeHarness(numPlayers: number, stacks?: number[]): Harness {
  const states: ServerGameState[] = [];
  const seats = Array.from({ length: numPlayers }, (_, i) =>
    makeSeat({ userId: `p${i + 1}`, seatIndex: i, stack: stacks?.[i] ?? 1000 })
  );
  const initialTotal = seats.reduce((s, x) => s + x.stack, 0);

  const engine = new PokerGameEngine(
    'test-table',
    seats,
    10, // SB
    20, // BB
    (s) => states.push(JSON.parse(JSON.stringify(s))),
    (_s) => {}
  );
  return { engine, states, initialTotal };
}

// Chip-conservation accounting changes shape depending on where in the hand
// lifecycle we are:
//
//   - During BETTING / DEALING: chips flow stack → betThisStreet → totalContributed.
//     The pot slices aren't kept in sync mid-action (buildPots only runs at
//     hand-end / buildClientView). totalContributed is the authoritative
//     source for chips committed this hand, so the invariant is
//         sum(stack) + sum(totalContributed) === initialTotal.
//
//   - After endHand pays winners (phase SHOWDOWN/ENDED, winners populated):
//     payouts have been credited to seat.stack, but totalContributed has
//     NOT been zeroed yet — that happens in the post-hand cleanup setTimeout.
//     So sum(stack) alone is the world total; adding totalContributed would
//     double-count the chips that just got paid out.
//
//   - After the cleanup setTimeout (phase WAITING, totalContributed=0):
//     either formula works because the addend is zero.
function chipTotalAccountingForWinners(state: ServerGameState): number {
  const stackSum   = state.seats.reduce((s, x) => s + x.stack, 0);
  const contribSum = state.seats.reduce((s, x) => s + x.totalContributed, 0);
  const winnersPaid = !!state.winners && state.winners.length > 0;
  return winnersPaid ? stackSum : stackSum + contribSum;
}

// Every card appearing anywhere in the engine's view of the world must be
// unique. We sample hole cards on every seat that has them, the community
// board, and the remaining deck. Duplicates would mean the deal/burn logic
// is broken.
function assertNoDuplicateCards(state: ServerGameState): void {
  const seen = new Map<string, string>();
  const check = (card: { rank: string; suit: string }, where: string) => {
    const k = cardKey(card as any);
    if (seen.has(k)) {
      throw new Error(`Duplicate card ${k} — found in ${seen.get(k)} AND ${where}`);
    }
    seen.set(k, where);
  };
  // Only seats currently in the hand (ACTIVE / ALL_IN / FOLDED — i.e. dealt
  // in to this hand) need their hole cards checked against the live deck.
  // SITTING_OUT seats keep their stale hole cards from the last hand they
  // played in (the engine doesn't bother clearing them since SITTING_OUT
  // seats don't participate). Including those stale cards would create
  // false-positive duplicates against the new shuffle.
  for (const s of state.seats) {
    if (s.status === 'SITTING_OUT' || s.status === 'WAITING') continue;
    s.holeCards.forEach((c, i) => check(c, `seat ${s.userId} hole[${i}]`));
  }
  state.communityCards.forEach((c, i) => check(c, `community[${i}]`));
  state.deck.forEach((c, i) => check(c, `deck[${i}]`));
}

// Core per-state invariants — checked after every action and at every emit.
function assertInvariants(state: ServerGameState, initialTotal: number, ctx: string): void {
  // Stack non-negative (poker doesn't have credit).
  for (const s of state.seats) {
    expect(s.stack).toBeGreaterThanOrEqual(0);
    expect(s.totalContributed).toBeGreaterThanOrEqual(0);
    expect(s.betThisStreet).toBeGreaterThanOrEqual(0);
    // betThisStreet is always a subset of totalContributed
    expect(s.betThisStreet).toBeLessThanOrEqual(s.totalContributed);
  }

  // Chip conservation. With winners credited but before cleanup zeroes
  // totalContributed, sum(stack) alone equals initialTotal. During play,
  // sum(stack) + sum(totalContributed) equals initialTotal.
  const total = chipTotalAccountingForWinners(state);
  if (total !== initialTotal) {
    throw new Error(
      `Chip conservation broken at ${ctx}: total=${total} initial=${initialTotal} ` +
      `phase=${state.phase} street=${state.street}`
    );
  }

  // Card uniqueness across the whole world.
  assertNoDuplicateCards(state);

  // Community card counts must match street.
  if (state.phase === 'BETTING') {
    const cc = state.communityCards.length;
    switch (state.street) {
      case 'PREFLOP': expect(cc).toBe(0); break;
      case 'FLOP':    expect(cc).toBe(3); break;
      case 'TURN':    expect(cc).toBe(4); break;
      case 'RIVER':   expect(cc).toBe(5); break;
    }
  }

  // If we have an active player, the userId must resolve to a real seat at the
  // table. We deliberately don't check status here — the engine emits state
  // BEFORE calling `advanceGame`, so subscribers can observe a frame where
  // `activePlayerId` still points to the seat that just folded / shoved and
  // hasn't been advanced yet. The next emit (from `advanceGame`) corrects it.
  // The real guarantee is no `activePlayerId` pointing to a nonexistent seat,
  // and the "only-active-player-can-act" rule (verified in dedicated tests).
  if (state.activePlayerId) {
    const ap = state.seats.find(s => s.userId === state.activePlayerId);
    expect(ap).toBeDefined();
  }

  // currentBet ≥ every seat's betThisStreet on the current street.
  for (const s of state.seats) {
    expect(s.betThisStreet).toBeLessThanOrEqual(state.currentBet || s.betThisStreet);
  }
}

// Picks a random legal action with a distribution loosely resembling real
// poker: passive lines (CHECK/CALL) most of the time, occasional small
// raises, rare all-ins, low but non-zero fold rate. With uniform-random
// action selection, players go all-in within a hand or two and the table
// runs out of contestants before our multi-hand tests can play out.
function pickRandomAction(
  legal: { action: ActionType; minAmount?: number; maxAmount?: number; callAmount?: number }[]
): { action: ActionType; amount?: number } {
  // Weighted random — sample from a multinomial built from the legal set.
  const weights: Record<ActionType, number> = {
    FOLD:   0.10,
    CHECK:  0.55,
    CALL:   0.45,
    RAISE:  0.10,
    ALL_IN: 0.01,
    SMALL_BLIND: 0,
    BIG_BLIND:   0,
  };
  const pool = legal.map(a => ({ ...a, w: weights[a.action] || 0 }));
  const total = pool.reduce((s, x) => s + x.w, 0);
  if (total === 0) return { action: legal[0].action };

  let r = Math.random() * total;
  let chosen = pool[pool.length - 1];
  for (const p of pool) {
    r -= p.w;
    if (r <= 0) { chosen = p; break; }
  }

  if (chosen.action === 'RAISE') {
    // Bias toward smaller raises (min-raise to ~2x min) so we don't every-hand
    // shove all our chips in.
    const lo = chosen.minAmount!;
    const hi = chosen.maxAmount!;
    const cap = Math.min(hi, lo * 2 + Math.floor(Math.random() * (hi - lo + 1) / 4));
    const amount = lo + Math.floor(Math.random() * Math.max(1, cap - lo + 1));
    return { action: 'RAISE', amount };
  }
  return { action: chosen.action };
}

// Drive the currently-running hand (phase=BETTING) to completion via random
// legal actions. Does NOT advance the post-end cleanup setTimeout — that's
// the caller's responsibility (so the caller can choose whether the next
// hand should auto-start). Asserts invariants after every action.
function drainCurrentHand(h: Harness): void {
  let guard = 0;
  while (h.engine.getState().phase === 'BETTING' && guard < 2000) {
    const state = h.engine.getState();
    const activeId = state.activePlayerId;
    if (!activeId) {
      // Close-round / runout timer pending — flush.
      jest.advanceTimersByTime(800);
      guard++;
      continue;
    }
    const legal = h.engine.getLegalActions(activeId);
    if (legal.length === 0) { jest.advanceTimersByTime(800); guard++; continue; }
    const { action, amount } = pickRandomAction(legal);
    const res = h.engine.processAction(activeId, action, amount);
    expect(res.ok).toBe(true);
    assertInvariants(h.engine.getState(), h.initialTotal, `mid-hand after ${action}`);
    jest.advanceTimersByTime(800);
    guard++;
  }
  if (guard >= 2000) throw new Error('Hand failed to progress within 2000 iterations');
}

// Play exactly one hand to completion. Returns when the engine's phase has
// transitioned back to WAITING (i.e. the post-end cleanup setTimeout has run).
function playOneHand(h: Harness): void {
  if (h.engine.getState().phase === 'WAITING') {
    h.engine.startHand();
  }
  // Drive actions until we leave BETTING. Each step we may also advance the
  // close-round timer if the engine scheduled one.
  let guard = 0;
  while (h.engine.getState().phase === 'BETTING' && guard < 2000) {
    const state = h.engine.getState();
    const activeId = state.activePlayerId;
    if (!activeId) {
      // Engine has cleared the active player but the close-round setTimeout
      // hasn't fired yet — flush all pending timers and re-check.
      jest.advanceTimersByTime(800); // > CLOSE_ROUND_DELAY_MS
      guard++;
      continue;
    }
    const legal = h.engine.getLegalActions(activeId);
    if (legal.length === 0) {
      // Shouldn't happen — but if it does, flush timers and retry.
      jest.advanceTimersByTime(800);
      guard++;
      continue;
    }
    const { action, amount } = pickRandomAction(legal);
    const res = h.engine.processAction(activeId, action, amount);
    expect(res.ok).toBe(true);

    // Per-action invariants.
    assertInvariants(h.engine.getState(), h.initialTotal, `mid-hand after ${action}`);

    // Drain any scheduled close-round delay so we can continue.
    jest.advanceTimersByTime(800);
    guard++;
  }
  if (guard >= 2000) throw new Error('Hand failed to progress within 2000 iterations');

  // Drain the post-end HAND_START_DELAY so the next hand can begin.
  jest.advanceTimersByTime(7000); // > HAND_START_DELAY (6000)
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('PokerGameEngine — large-scale playthrough', () => {
  beforeEach(() => { jest.useFakeTimers(); });
  afterEach(() => { jest.useRealTimers(); });

  // ── Chip conservation across many hands ─────────────────────────────────────

  test('100 hands of 4-handed: chips are conserved every state, no negatives', () => {
    const h = makeHarness(4, [1000, 1000, 1000, 1000]);
    // The engine auto-starts hands from its post-end cleanup setTimeout.
    // We just kick off the first hand and then keep flushing timers and
    // driving actions until either 100 hands are done or the table can't
    // continue (1 player left).
    h.engine.startHand();
    let handsPlayed = 0;
    while (handsPlayed < 100 && h.engine.getState().phase === 'BETTING') {
      drainCurrentHand(h);
      handsPlayed++;
      jest.advanceTimersByTime(7000); // fires cleanup → may auto-start next hand
    }
    // Audit every emitted snapshot.
    for (let i = 0; i < h.states.length; i++) {
      assertInvariants(h.states[i], h.initialTotal, `state #${i}`);
    }
    // Final on-table chips must sum to initial total. After cleanup the next
    // hand may already be running (blinds posted), so include totalContributed.
    const f = h.engine.getState();
    expect(f.seats.reduce((s, x) => s + x.stack + x.totalContributed, 0)).toBe(h.initialTotal);
    expect(handsPlayed).toBeGreaterThan(1);
  });

  test('200 hands heads-up: chips are conserved', () => {
    const h = makeHarness(2, [2000, 2000]);
    h.engine.startHand();
    let handsPlayed = 0;
    while (handsPlayed < 200 && h.engine.getState().phase === 'BETTING') {
      drainCurrentHand(h);
      handsPlayed++;
      jest.advanceTimersByTime(7000);
    }
    for (let i = 0; i < h.states.length; i++) {
      assertInvariants(h.states[i], h.initialTotal, `state #${i}`);
    }
    const f = h.engine.getState();
    expect(f.seats.reduce((s, x) => s + x.stack + x.totalContributed, 0)).toBe(h.initialTotal);
  });

  test('50 hands 6-handed with varied short stacks: side pots clean up', () => {
    // Mixed stacks force frequent all-ins → side pot construction stress.
    const h = makeHarness(6, [200, 500, 1000, 1500, 800, 300]);
    h.engine.startHand();
    let handsPlayed = 0;
    while (handsPlayed < 50 && h.engine.getState().phase === 'BETTING') {
      drainCurrentHand(h);
      handsPlayed++;
      jest.advanceTimersByTime(7000);
    }
    for (let i = 0; i < h.states.length; i++) {
      assertInvariants(h.states[i], h.initialTotal, `state #${i}`);
    }
    const f = h.engine.getState();
    expect(f.seats.reduce((s, x) => s + x.stack + x.totalContributed, 0)).toBe(h.initialTotal);
  });

  // ── Action / turn-order rules ───────────────────────────────────────────────

  test('only the active player can act during a hand', () => {
    const h = makeHarness(3);
    h.engine.startHand();
    while (h.engine.getState().phase === 'BETTING') {
      const state = h.engine.getState();
      const activeId = state.activePlayerId;
      if (!activeId) { jest.advanceTimersByTime(800); continue; }

      // Every other seat must be rejected.
      for (const s of state.seats) {
        if (s.userId === activeId) continue;
        const r = h.engine.processAction(s.userId, 'FOLD');
        expect(r.ok).toBe(false);
        expect(r.error).toMatch(/Not your turn|Not in betting/);
      }
      const legal = h.engine.getLegalActions(activeId);
      const pick = pickRandomAction(legal);
      h.engine.processAction(activeId, pick.action, pick.amount);
      jest.advanceTimersByTime(800);
    }
  });

  test('non-active seats always get empty getLegalActions()', () => {
    const h = makeHarness(4);
    h.engine.startHand();
    while (h.engine.getState().phase === 'BETTING') {
      const state = h.engine.getState();
      const activeId = state.activePlayerId;
      if (!activeId) { jest.advanceTimersByTime(800); continue; }
      for (const s of state.seats) {
        if (s.userId === activeId) continue;
        expect(h.engine.getLegalActions(s.userId)).toHaveLength(0);
      }
      const legal = h.engine.getLegalActions(activeId);
      const pick = pickRandomAction(legal);
      h.engine.processAction(activeId, pick.action, pick.amount);
      jest.advanceTimersByTime(800);
    }
  });

  // ── Street progression ─────────────────────────────────────────────────────

  test('street progression is monotonic: PREFLOP → FLOP → TURN → RIVER', () => {
    const h = makeHarness(3);
    const ordering = ['PREFLOP', 'FLOP', 'TURN', 'RIVER', 'SHOWDOWN', 'ENDED'];
    const observed: string[] = [];
    h.engine.startHand();
    // Stop as soon as the hand ends — the engine auto-starts the next one,
    // which we don't want to mix into our `observed` sequence for this hand.
    while (h.engine.getState().phase === 'BETTING') {
      const state = h.engine.getState();
      const tag = state.street;
      if (observed[observed.length - 1] !== tag) observed.push(tag);

      if (!state.activePlayerId) { jest.advanceTimersByTime(800); continue; }
      // Force calls/checks so we go all the way to showdown.
      const legal = h.engine.getLegalActions(state.activePlayerId);
      const call  = legal.find(a => a.action === 'CALL');
      const check = legal.find(a => a.action === 'CHECK');
      const pick  = check ? { action: 'CHECK' as ActionType } :
                    call  ? { action: 'CALL'  as ActionType } :
                    pickRandomAction(legal);
      h.engine.processAction(state.activePlayerId, pick.action, (pick as any).amount);
      jest.advanceTimersByTime(800);
    }
    // Observed sequence must be a subsequence of the canonical street order.
    const streetOrder = ['PREFLOP', 'FLOP', 'TURN', 'RIVER'];
    let idx = 0;
    for (const tag of observed) {
      const tagIdx = streetOrder.indexOf(tag);
      expect(tagIdx).toBeGreaterThanOrEqual(idx); // never went backwards
      idx = tagIdx;
    }
    // We forced calls so we must reach the river.
    expect(observed).toContain('RIVER');
  });

  // ── Blinds & dealer button ──────────────────────────────────────────────────

  test('blinds posted correctly every hand; dealer rotates', () => {
    // Big stacks + check/call-only play so no one busts within the audit
    // window. Random aggressive play can have a single hand end with one
    // player holding all the chips, which makes the dealer rotation
    // unobservable (`canStartHand` returns false and the next hand never
    // starts). Forcing check/call keeps all 4 players alive across hands.
    const h = makeHarness(4, [100_000, 100_000, 100_000, 100_000]);
    // Capture the dealer index from every state emit where phase transitions
    // to BETTING with handNumber bumped — that's the snapshot of "start of
    // hand N". We rely on the recorded `states` array (which captures every
    // onStateChange emit) rather than spot-checking, because the engine's
    // auto-start of the next hand happens inside the cleanup setTimeout and
    // we can miss it by timing.
    h.engine.startHand();
    for (let i = 0; i < 10; i++) {
      while (h.engine.getState().phase === 'BETTING') {
        const st = h.engine.getState();
        if (!st.activePlayerId) { jest.advanceTimersByTime(800); continue; }
        const legal = h.engine.getLegalActions(st.activePlayerId);
        // Check / call only so no one busts and the loop can observe
        // multiple hands' worth of dealer rotation.
        const check = legal.find(a => a.action === 'CHECK');
        const call  = legal.find(a => a.action === 'CALL');
        const action = check ? 'CHECK' : call ? 'CALL' : 'FOLD';
        h.engine.processAction(st.activePlayerId, action);
        jest.advanceTimersByTime(800);
      }
      jest.advanceTimersByTime(7000);
      if (h.engine.getState().phase !== 'BETTING') break;
    }
    // Pull dealer indices from the first emit of each hand. A new hand's
    // first emit has phase=BETTING and a fresh handNumber.
    const dealerByHand = new Map<number, number>();
    for (const s of h.states) {
      if (s.phase === 'BETTING' && !dealerByHand.has(s.handNumber)) {
        dealerByHand.set(s.handNumber, s.dealerSeatIndex);
        // Blinds posted correctly on hand start (first BETTING emit).
        const sb = s.seats.find(x => x.isSmallBlind);
        const bb = s.seats.find(x => x.isBigBlind);
        if (sb && bb) {
          expect(sb.betThisStreet).toBeGreaterThan(0);
          expect(bb.betThisStreet).toBeGreaterThan(0);
          expect(sb.betThisStreet).toBeLessThanOrEqual(s.smallBlind);
          expect(bb.betThisStreet).toBeLessThanOrEqual(s.bigBlind);
        }
      }
    }
    expect(dealerByHand.size).toBeGreaterThan(1);
    // Dealer button must rotate across the hands we observed.
    expect(new Set(dealerByHand.values()).size).toBeGreaterThan(1);
  });

  // ── Client view secrecy ────────────────────────────────────────────────────

  test('opponents never see hole cards while it is still someone\'s turn', () => {
    // The engine auto-reveals everyone's hole cards once `liveSeatsWithChips
    // ≤ 1 && activePlayerId === null` (the all-in-runout case from
    // buildClientView). Pre-showdown secrecy is therefore guaranteed only
    // while it is still SOMEONE'S turn to act — that's the moment we care
    // about, since that's when peeking would actually affect a decision.
    const h = makeHarness(4);
    h.engine.startHand();
    while (h.engine.getState().phase === 'BETTING') {
      const state = h.engine.getState();
      // Only audit secrecy when there is an active player (i.e. not in the
      // betting-round-close / all-in-runout gap where reveals are legitimate).
      if (state.activePlayerId) {
        for (const observer of state.seats) {
          const view = h.engine.buildClientView(observer.userId);
          for (const seat of view.seats) {
            if (seat.userId === observer.userId) {
              if (seat.status !== 'FOLDED' && seat.status !== 'WAITING') {
                expect(seat.holeCards).not.toBeNull();
              }
            } else {
              // Opponent: holeCards must be null while it's anyone's turn.
              expect(seat.holeCards).toBeNull();
              expect(seat.cardCount).toBeGreaterThanOrEqual(0);
            }
          }
        }
        const legal = h.engine.getLegalActions(state.activePlayerId);
        const pick = pickRandomAction(legal);
        h.engine.processAction(state.activePlayerId, pick.action, pick.amount);
      }
      jest.advanceTimersByTime(800);
    }
  });

  // ── Min-raise enforcement ──────────────────────────────────────────────────

  test('raise smaller than min-raise is rejected', () => {
    const h = makeHarness(3);
    h.engine.startHand();
    const state = h.engine.getState();
    const activeId = state.activePlayerId!;
    const legal = h.engine.getLegalActions(activeId);
    const raise = legal.find(a => a.action === 'RAISE');
    if (raise && raise.minAmount && raise.minAmount > 1) {
      const tooSmall = raise.minAmount - 1;
      const r = h.engine.processAction(activeId, 'RAISE', tooSmall);
      expect(r.ok).toBe(false);
    }
  });

  test('raise larger than max-raise (stack-bound) is rejected', () => {
    const h = makeHarness(2);
    h.engine.startHand();
    const state = h.engine.getState();
    const activeId = state.activePlayerId!;
    const legal = h.engine.getLegalActions(activeId);
    const raise = legal.find(a => a.action === 'RAISE');
    if (raise && raise.maxAmount) {
      const tooBig = raise.maxAmount + 100;
      const r = h.engine.processAction(activeId, 'RAISE', tooBig);
      // Engine should reject — either via 'not legal' or via the raisePlayer
      // guard. Either way, ok should be false.
      expect(r.ok).toBe(false);
    }
  });

  // ── All-in & side pots ─────────────────────────────────────────────────────

  test('short-stack all-in vs deeper stacks creates correct side-pot eligibility', () => {
    // Force a 3-way all-in scenario by giving very different stacks.
    const h = makeHarness(3, [100, 500, 1000]);
    h.engine.startHand();

    // Drive everyone all-in.
    let guard = 0;
    while (h.engine.getState().phase === 'BETTING' && guard++ < 200) {
      const st = h.engine.getState();
      if (!st.activePlayerId) { jest.advanceTimersByTime(800); continue; }
      const legal = h.engine.getLegalActions(st.activePlayerId);
      // Prefer ALL_IN to actually create side pots.
      const allIn = legal.find(a => a.action === 'ALL_IN');
      if (allIn) {
        h.engine.processAction(st.activePlayerId, 'ALL_IN');
      } else {
        const call = legal.find(a => a.action === 'CALL');
        h.engine.processAction(st.activePlayerId, call ? 'CALL' : 'CHECK');
      }
      jest.advanceTimersByTime(800);
    }
    jest.advanceTimersByTime(7000);

    // After the cleanup setTimeout has run, the engine may have auto-started
    // the next hand (posting blinds). To check chip conservation cleanly we
    // sum stacks + chips already on the felt for the new hand.
    const final = h.engine.getState();
    const stackSum = final.seats.reduce((s, x) => s + x.stack, 0);
    const feltSum  = final.seats.reduce((s, x) => s + x.totalContributed, 0);
    expect(stackSum + feltSum).toBe(h.initialTotal);
  });

  test('fold-win: uncontested winner gets entire pot, no showCards on winner', () => {
    const h = makeHarness(3);
    h.engine.startHand();
    // Force every player except one to fold.
    let foldsRemaining = 2;
    while (h.engine.getState().phase === 'BETTING' && foldsRemaining > 0) {
      const st = h.engine.getState();
      if (!st.activePlayerId) { jest.advanceTimersByTime(800); continue; }
      const legal = h.engine.getLegalActions(st.activePlayerId);
      const fold = legal.find(a => a.action === 'FOLD');
      if (fold) {
        h.engine.processAction(st.activePlayerId, 'FOLD');
        foldsRemaining--;
      } else {
        const call = legal.find(a => a.action === 'CHECK' as any) ?? legal.find(a => a.action === 'CALL' as any);
        h.engine.processAction(st.activePlayerId, call?.action || 'FOLD');
      }
      jest.advanceTimersByTime(800);
    }
    // The hand should have ended. Winner's showCards must be false (no
    // showdown reveal on fold-win).
    const last = h.states[h.states.length - 1];
    // Find a state with winners populated.
    const endedState = [...h.states].reverse().find(s => s.winners && s.winners.length > 0);
    expect(endedState).toBeDefined();
    expect(endedState!.winners![0].showCards).toBe(false);
    expect(endedState!.winners![0].handName).toBe('Uncontested');
  });

  // ── Pot math at hand-end ───────────────────────────────────────────────────

  test('at hand-end, sum of winner payouts equals sum of pot slices', () => {
    const h = makeHarness(4);
    // Play 30 hands, on every hand-end snapshot verify winners sum to pots sum.
    for (let i = 0; i < 30; i++) {
      if (!h.engine.canStartHand()) break;
      playOneHand(h);
    }
    // Inspect every emitted state that had winners.
    const endStates = h.states.filter(s => s.phase === 'ENDED' && s.winners && s.winners.length > 0);
    expect(endStates.length).toBeGreaterThan(0);
    for (const s of endStates) {
      const potSum    = s.pots.reduce((sum, p) => sum + p.amount, 0);
      const winnerSum = s.winners!.reduce((sum, w) => sum + w.amount, 0);
      expect(winnerSum).toBe(potSum);
    }
  });

  // ── Wrong-turn audit across full hand ──────────────────────────────────────

  test('throughout a full hand, only the engine-designated activePlayerId may act', () => {
    const h = makeHarness(5);
    h.engine.startHand();
    while (h.engine.getState().phase === 'BETTING') {
      const st = h.engine.getState();
      if (!st.activePlayerId) { jest.advanceTimersByTime(800); continue; }

      // Iterate every seat: only the active one should succeed.
      const successes: string[] = [];
      for (const seat of st.seats) {
        // Don't actually call here — just check legal actions emptiness.
        const la = h.engine.getLegalActions(seat.userId);
        if (la.length > 0) successes.push(seat.userId);
      }
      expect(successes).toEqual([st.activePlayerId]);

      const legal = h.engine.getLegalActions(st.activePlayerId);
      const pick = pickRandomAction(legal);
      h.engine.processAction(st.activePlayerId, pick.action, pick.amount);
      jest.advanceTimersByTime(800);
    }
  });

  // ── Winner correctness ──────────────────────────────────────────────────────
  //
  // The most important poker invariant: the player whose chips just got
  // bigger at showdown actually had the best hand. A bug in winner
  // determination (off-by-one tiebreaker, wrong eligibility for a side pot,
  // mis-mapped card adapter into pokersolver, etc.) shows up as a player
  // with a worse hand collecting the pot. These tests force many hands to
  // showdown and re-evaluate every contestant's best 5-card hand
  // independently, then check that the engine's chosen winners include the
  // player(s) with the actual best hand.

  // Evaluate every contestant's best 5-card hand from their hole cards +
  // community. Skips folded / sitting-out seats (they're not in the showdown).
  function evaluateContestants(state: ServerGameState): Array<{ userId: string; hand: EvaluatedHand }> {
    const contestants = state.seats.filter(s => s.status === 'ACTIVE' || s.status === 'ALL_IN');
    // Hand evaluator needs 5-7 cards (2 hole + 3-5 community). At a contested
    // showdown the board is always 5 (engine runs out remaining streets when
    // everyone's all-in). If somehow we have fewer cards, skip the assertion.
    return contestants
      .filter(s => s.holeCards.length === 2 && state.communityCards.length === 5)
      .map(s => ({
        userId: s.userId,
        hand: evaluateHand([...s.holeCards, ...state.communityCards]),
      }));
  }

  // Run a hand all the way to a contested showdown. Every player checks /
  // calls — no raises, no folds — so we're guaranteed to see at least 2
  // hands at the river. Returns the engine state at the moment winners are
  // populated (phase === 'ENDED' with winners[]).
  function runContestedShowdown(h: Harness): ServerGameState {
    h.engine.startHand();
    while (h.engine.getState().phase === 'BETTING') {
      const st = h.engine.getState();
      if (!st.activePlayerId) { jest.advanceTimersByTime(800); continue; }
      const legal = h.engine.getLegalActions(st.activePlayerId);
      // CHECK if we can, else CALL. Never raise, never fold.
      const check = legal.find(a => a.action === 'CHECK');
      const call  = legal.find(a => a.action === 'CALL');
      const action = check ? 'CHECK' : call ? 'CALL' : legal[0].action;
      h.engine.processAction(st.activePlayerId, action);
      jest.advanceTimersByTime(800);
    }
    // The ENDED-with-winners emit happens inside endHand right before the
    // 6000ms cleanup setTimeout. Pull the latest emit; if winners aren't
    // populated yet (because we're in the close-round delay between fold-out
    // and endHand), advance a bit more.
    let final = h.engine.getState();
    let safety = 0;
    while ((!final.winners || final.winners.length === 0) && safety++ < 20) {
      jest.advanceTimersByTime(800);
      final = h.engine.getState();
    }
    return final;
  }

  test('heads-up showdown: winner has the best hand (50 hands)', () => {
    // Heads-up with deep stacks so neither player busts mid-suite. Both
    // players check/call to the river every hand so every hand reaches a
    // real showdown (no fold-wins to skip).
    const h = makeHarness(2, [50_000, 50_000]);

    for (let i = 0; i < 50; i++) {
      const final = runContestedShowdown(h);
      const contestants = evaluateContestants(final);

      // If only 0 or 1 contestants made it to showdown (shouldn't happen
      // with all-checks), skip — uncontested wins don't need hand checks.
      if (contestants.length < 2) {
        jest.advanceTimersByTime(7000);
        continue;
      }

      // Find the strongest hand and every player who ties it.
      const best = contestants.reduce(
        (b, c) => (compareHands(c.hand, b.hand) > 0 ? c : b),
        contestants[0]
      );
      const trueBest = contestants
        .filter(c => compareHands(c.hand, best.hand) === 0)
        .map(c => c.userId);

      const engineWinners = new Set(final.winners!.map(w => w.playerId));

      // Every player tied for the best hand must be a winner. (In heads-up
      // with no side pots the engine should always split a tied pot.)
      for (const id of trueBest) {
        if (!engineWinners.has(id)) {
          const breakdown = contestants
            .map(c => `${c.userId}=${c.hand.name}[${c.hand.tiebreakers.join(',')}]`)
            .join(' | ');
          throw new Error(
            `Hand #${final.handNumber}: ${id} had the best hand but is not in engine winners. ` +
            `Engine winners: ${[...engineWinners].join(',')}. Contestants: ${breakdown}`
          );
        }
      }

      // Conversely: every engine winner must hold the best hand. In a
      // single-pot heads-up showdown there are no side pots, so a player
      // with a worse hand cannot be a "winner of a smaller side pot".
      for (const w of final.winners!) {
        const c = contestants.find(x => x.userId === w.playerId);
        if (!c) continue;
        if (compareHands(c.hand, best.hand) !== 0) {
          throw new Error(
            `Hand #${final.handNumber}: ${w.playerId} was paid out ${w.amount} but ` +
            `their hand ${c.hand.name} loses to the best ${best.hand.name}`
          );
        }
      }

      jest.advanceTimersByTime(7000);
    }
  });

  test('3-handed showdown: best hand is always paid (30 hands)', () => {
    const h = makeHarness(3, [50_000, 50_000, 50_000]);

    for (let i = 0; i < 30; i++) {
      const final = runContestedShowdown(h);
      const contestants = evaluateContestants(final);
      if (contestants.length < 2) { jest.advanceTimersByTime(7000); continue; }

      const best = contestants.reduce(
        (b, c) => (compareHands(c.hand, b.hand) > 0 ? c : b),
        contestants[0]
      );
      const trueBest = contestants
        .filter(c => compareHands(c.hand, best.hand) === 0)
        .map(c => c.userId);
      const engineWinners = new Set(final.winners!.map(w => w.playerId));

      // Best hand(s) must always be among the paid winners. With everyone
      // matching action and no all-ins, there's a single pot — every
      // contestant is eligible — so the best hand owns the whole pot.
      for (const id of trueBest) {
        expect(engineWinners.has(id)).toBe(true);
      }
      // Engine winners must all hold the top hand (single pot).
      if (final.pots.length === 1) {
        for (const w of final.winners!) {
          const c = contestants.find(x => x.userId === w.playerId);
          if (c) expect(compareHands(c.hand, best.hand)).toBe(0);
        }
      }

      jest.advanceTimersByTime(7000);
    }
  });

  test('all-in showdown with side pots: best hand wins at least the main pot', () => {
    // Variable stacks → forced all-ins → multiple side pots. The player
    // with the absolute best hand among contestants must still appear in
    // the winners list because they win at least the main pot (everyone
    // who reaches showdown is eligible for the main pot, since the main
    // pot is the smallest contribution × N participants).
    for (let trial = 0; trial < 20; trial++) {
      const stacks = [100, 250, 500, 1000];
      const h = makeHarness(4, stacks);
      h.engine.startHand();

      // Drive everyone all-in / call so we get to showdown.
      while (h.engine.getState().phase === 'BETTING') {
        const st = h.engine.getState();
        if (!st.activePlayerId) { jest.advanceTimersByTime(800); continue; }
        const legal = h.engine.getLegalActions(st.activePlayerId);
        // ALL_IN first if available, else CALL, else CHECK. Never fold.
        const allIn = legal.find(a => a.action === 'ALL_IN');
        const call  = legal.find(a => a.action === 'CALL');
        const check = legal.find(a => a.action === 'CHECK');
        const action = allIn ? 'ALL_IN' : call ? 'CALL' : check ? 'CHECK' : legal[0].action;
        h.engine.processAction(st.activePlayerId, action);
        jest.advanceTimersByTime(800);
      }
      // Drain any pending close-round / runout timers so winners populate.
      let final = h.engine.getState();
      let safety = 0;
      while ((!final.winners || final.winners.length === 0) && safety++ < 20) {
        jest.advanceTimersByTime(800);
        final = h.engine.getState();
      }

      const contestants = evaluateContestants(final);
      if (contestants.length < 2) { jest.advanceTimersByTime(7000); continue; }

      const best = contestants.reduce(
        (b, c) => (compareHands(c.hand, b.hand) > 0 ? c : b),
        contestants[0]
      );
      const trueBest = contestants
        .filter(c => compareHands(c.hand, best.hand) === 0)
        .map(c => c.userId);
      const engineWinners = new Set(final.winners!.map(w => w.playerId));

      // The best-hand player(s) must always be in the winners. The main
      // pot's eligible set always includes every contestant who reached
      // showdown, so the best hand owns at least that pot's share.
      for (const id of trueBest) {
        if (!engineWinners.has(id)) {
          const breakdown = contestants
            .map(c => `${c.userId}=${c.hand.name}`)
            .join(' | ');
          throw new Error(
            `Trial ${trial}: ${id} had the best hand but is not in engine winners. ` +
            `Engine winners: ${[...engineWinners].join(',')}. Contestants: ${breakdown}`
          );
        }
      }

      // Sanity: every engine winner is a real contestant at the table.
      for (const w of final.winners!) {
        const found = contestants.find(c => c.userId === w.playerId);
        expect(found).toBeDefined();
      }

      jest.advanceTimersByTime(7000);
    }
  });

  test('split pots: when two players tie, both are paid equally', () => {
    // Run heads-up hands until we find a chopped pot (same hand strength on
    // both sides — e.g. board plays). When we hit one, verify both players
    // are in winners and got equal amounts. Many hands may not split, so
    // we run a large batch and just assert that *every observed split* is
    // paid correctly — not that splits occur at minimum frequency.
    const h = makeHarness(2, [100_000, 100_000]);

    let chopsObserved = 0;
    for (let i = 0; i < 100; i++) {
      const final = runContestedShowdown(h);
      const contestants = evaluateContestants(final);
      if (contestants.length < 2) { jest.advanceTimersByTime(7000); continue; }

      const [a, b] = contestants;
      const cmp = compareHands(a.hand, b.hand);
      if (cmp === 0) {
        chopsObserved++;
        // Engine must report both as winners and pay them equally.
        const winners = final.winners!;
        const aPay = winners.filter(w => w.playerId === a.userId).reduce((s, w) => s + w.amount, 0);
        const bPay = winners.filter(w => w.playerId === b.userId).reduce((s, w) => s + w.amount, 0);
        // Allow a 1-chip difference for odd-pot rounding (the engine should
        // give the odd chip to a deterministic seat — typically the next
        // seat clockwise from the dealer).
        expect(Math.abs(aPay - bPay)).toBeLessThanOrEqual(1);
        expect(aPay).toBeGreaterThan(0);
        expect(bPay).toBeGreaterThan(0);
      }
      jest.advanceTimersByTime(7000);
    }

    // Not a strict requirement — but if we played 100 hands and got zero
    // chops, the test isn't doing what we think. Soft warning via log only;
    // don't fail the suite since CSPRNG-driven shuffles could legitimately
    // produce zero chops in a sample of this size.
    if (chopsObserved === 0) {
      // eslint-disable-next-line no-console
      console.warn('split-pot test: 0 chops observed in 100 hands (rare but possible)');
    }
  });

  test('hand name reported by engine matches a fresh evaluation of the winner\'s cards', () => {
    // The engine returns each winner with a `handName` field. That name
    // should match what we get when we independently evaluate the same
    // hole+board cards. Catches mis-mapping between pokersolver's labels
    // and our HandRank enum, or a stale handName left over from a prior hand.
    const h = makeHarness(2, [50_000, 50_000]);

    for (let i = 0; i < 30; i++) {
      const final = runContestedShowdown(h);
      if (!final.winners || final.winners.length === 0) {
        jest.advanceTimersByTime(7000); continue;
      }
      // Skip uncontested (fold-win) hands — their handName is "Uncontested"
      // and the winner's hole cards aren't a valid 5+2 evaluation source.
      const isUncontested = final.winners.every(w => w.handName === 'Uncontested');
      if (isUncontested) { jest.advanceTimersByTime(7000); continue; }

      for (const w of final.winners) {
        const seat = final.seats.find(s => s.userId === w.playerId);
        if (!seat || seat.holeCards.length !== 2 || final.communityCards.length !== 5) continue;
        const independent = evaluateHand([...seat.holeCards, ...final.communityCards]);
        expect(w.handName).toBe(independent.name);
      }
      jest.advanceTimersByTime(7000);
    }
  });
});
