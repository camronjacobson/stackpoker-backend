// PLO-specific tests for PokerGameEngine.
//
// Verifies:
//   - 4 hole cards dealt per seat
//   - getLegalActions surfaces FOLD/CHECK-or-CALL/RAISE/ALL_IN every street,
//     not just ALL_IN (the regression we're hunting)
//   - Pot-limit raise cap matches the formula: pot + call + own bet
//   - Hand evaluation uses exactly 2 hole + 3 board (pokersolver 'omaha')
//   - Chip conservation across PLO playthroughs

import { PokerGameEngine } from '../src/game/gameEngine';
import { ServerGameState, ActionType } from '../src/game/gameState.types';
import { evaluatePLOHand } from '../src/game/handEvaluator';
import { Card } from '../src/game/deck';

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

function makePLOEngine(numPlayers: number, stacks?: number[]) {
  const states: ServerGameState[] = [];
  const seats = Array.from({ length: numPlayers }, (_, i) =>
    makeSeat({ userId: `p${i + 1}`, seatIndex: i, stack: stacks?.[i] ?? 1000 })
  );
  const engine = new PokerGameEngine(
    'plo-test',
    seats,
    10, 20,
    (s) => states.push(JSON.parse(JSON.stringify(s))),
    () => {},
    'PLO',
  );
  return { engine, states };
}

describe('PokerGameEngine — PLO', () => {
  beforeEach(() => { jest.useFakeTimers(); });
  afterEach(() => { jest.useRealTimers(); });

  // ─── Fundamentals ─────────────────────────────────────────────────────────

  test('deals 4 hole cards per seat in PLO', () => {
    const { engine } = makePLOEngine(3);
    engine.startHand();
    const st = engine.getState();
    expect(st.gameType).toBe('PLO');
    for (const s of st.seats) {
      // Every dealt-in seat should have exactly 4 hole cards.
      if (s.status === 'ACTIVE' || s.status === 'ALL_IN') {
        expect(s.holeCards).toHaveLength(4);
      }
    }
  });

  test('evaluatePLOHand requires exactly 4 hole + 3-5 board', () => {
    const h: Card[] = [
      { rank: 'A', suit: 'S' }, { rank: 'K', suit: 'H' },
      { rank: 'Q', suit: 'D' }, { rank: 'J', suit: 'C' },
    ];
    const b: Card[] = [
      { rank: 'T', suit: 'S' }, { rank: '9', suit: 'H' }, { rank: '8', suit: 'D' },
    ];
    expect(() => evaluatePLOHand(h, b)).not.toThrow();
    expect(() => evaluatePLOHand(h.slice(0, 3), b)).toThrow(/4 hole cards/);
    expect(() => evaluatePLOHand(h, b.slice(0, 2))).toThrow(/3.5 board/);
  });

  test('PLO must-use-exactly-2-hole rule: 4 hearts in hand + 1 heart on board is NOT a flush', () => {
    // All 4 hole cards hearts, only 1 heart on board → can't make a flush in
    // PLO (would need 2 hole + 3 board hearts). Best should drop to pair/high.
    const hole: Card[] = [
      { rank: 'A', suit: 'H' }, { rank: 'K', suit: 'H' },
      { rank: 'Q', suit: 'H' }, { rank: 'J', suit: 'H' },
    ];
    const board: Card[] = [
      { rank: '2', suit: 'H' }, // only heart on board
      { rank: '7', suit: 'S' },
      { rank: '9', suit: 'D' },
      { rank: 'T', suit: 'C' },
      { rank: '3', suit: 'C' },
    ];
    const hand = evaluatePLOHand(hole, board);
    expect(hand.name).not.toBe('Flush');
  });

  test('PLO must-use-exactly-2-hole rule: 2 hole hearts + 3 board hearts IS a flush', () => {
    const hole: Card[] = [
      { rank: 'A', suit: 'H' }, { rank: 'K', suit: 'H' },
      { rank: 'Q', suit: 'S' }, { rank: 'J', suit: 'D' }, // distractors
    ];
    const board: Card[] = [
      { rank: '2', suit: 'H' },
      { rank: '7', suit: 'H' },
      { rank: '9', suit: 'H' },
      { rank: 'T', suit: 'C' },
      { rank: '3', suit: 'C' },
    ];
    const hand = evaluatePLOHand(hole, board);
    expect(hand.name).toBe('Flush');
  });

  // ─── Action surface (the iOS "only All In" regression) ────────────────────

  test('PLO heads-up preflop: SB sees FOLD/CALL/RAISE/ALL_IN (not just ALL_IN)', () => {
    const { engine } = makePLOEngine(2, [1000, 1000]);
    engine.startHand();
    const st = engine.getState();
    const la = engine.getLegalActions(st.activePlayerId!);
    const names = la.map(a => a.action).sort();
    expect(names).toEqual(['ALL_IN', 'CALL', 'FOLD', 'RAISE']);
    const raise = la.find(a => a.action === 'RAISE')!;
    // Pot-limit preflop: SB facing BB (20). Pot = SB+BB = 30, toCall = 10,
    // potAfterCall = 40, potLimitMax = 40 + 10 + 10 = 60. Min = currentBet
    // (20) + minRaise (20) = 40.
    expect(raise.minAmount).toBe(40);
    expect(raise.maxAmount).toBe(60);
  });

  test('PLO heads-up: BB option after SB call sees FOLD/CHECK/RAISE/ALL_IN', () => {
    const { engine } = makePLOEngine(2);
    engine.startHand();
    engine.processAction(engine.getState().activePlayerId!, 'CALL'); // SB calls
    const la = engine.getLegalActions(engine.getState().activePlayerId!);
    const names = la.map(a => a.action).sort();
    expect(names).toEqual(['ALL_IN', 'CHECK', 'FOLD', 'RAISE']);
  });

  test('PLO 3-handed preflop: each player gets RAISE in legal actions', () => {
    const { engine } = makePLOEngine(3);
    engine.startHand();
    // UTG (first to act preflop in 3-handed = button = p1) — RAISE present.
    let st = engine.getState();
    let names = engine.getLegalActions(st.activePlayerId!).map(a => a.action);
    expect(names).toContain('RAISE');

    engine.processAction(st.activePlayerId!, 'CALL'); // BTN calls
    st = engine.getState();
    names = engine.getLegalActions(st.activePlayerId!).map(a => a.action);
    expect(names).toContain('RAISE'); // SB

    engine.processAction(st.activePlayerId!, 'CALL'); // SB calls
    st = engine.getState();
    names = engine.getLegalActions(st.activePlayerId!).map(a => a.action);
    expect(names).toContain('RAISE'); // BB option
  });

  test('PLO postflop: RAISE still legal after check-around to flop', () => {
    const { engine } = makePLOEngine(2);
    engine.startHand();
    // SB calls, BB checks → flop. Drain close-round + any setTimeout that
    // assigns the next active player.
    engine.processAction(engine.getState().activePlayerId!, 'CALL');
    engine.processAction(engine.getState().activePlayerId!, 'CHECK');
    // Drain all pending engine timers so we land postflop with an active
    // player assigned (advanceStreet schedules through setTimeout chains).
    for (let i = 0; i < 5; i++) jest.advanceTimersByTime(1500);

    const st = engine.getState();
    expect(st.street).toBe('FLOP');
    expect(st.communityCards).toHaveLength(3);
    expect(st.activePlayerId).not.toBeNull();
    const names = engine.getLegalActions(st.activePlayerId!).map(a => a.action);
    // Postflop with no bet yet: FOLD, CHECK, RAISE (=bet), ALL_IN
    expect(names).toContain('RAISE');
    expect(names).toContain('CHECK');
  });

  test('PLO pot-limit cap: raise cannot exceed pot + call + own bet', () => {
    const { engine } = makePLOEngine(2, [10000, 10000]); // deep stacks
    engine.startHand();
    const st = engine.getState();
    const la = engine.getLegalActions(st.activePlayerId!);
    const raise = la.find(a => a.action === 'RAISE')!;
    // Even though stacks are 10k, pot-limit caps the max at 60 preflop HU.
    expect(raise.maxAmount).toBeLessThan(100);
    expect(raise.maxAmount).toBe(60);
  });

  test('PLO rejects above-pot raise on the wire', () => {
    const { engine } = makePLOEngine(2, [10000, 10000]);
    engine.startHand();
    const active = engine.getState().activePlayerId!;
    // Stack-bound check passes (10000 > 200), but pot-limit cap (60) should fail.
    const r = engine.processAction(active, 'RAISE', 200);
    expect(r.ok).toBe(false);
    expect((r as any).error).toMatch(/pot limit/i);
  });

  // ─── Bot fold-show in PLO ───────────────────────────────────────────────

  test('PLO: bot folded hand stays hidden until hand-end, then reveals all 4 mucked cards', () => {
    // Two-handed PLO with p1 a bot. Contract under test:
    //   (a) On the fold action, the bot's `voluntaryShownCardIndices` is
    //       empty — folded hole cards must NOT leak mid-hand.
    //   (b) At hand-end (here: 1v1 fold → uncontested, so endHand fires
    //       after CLOSE_ROUND_DELAY_MS once blind bets are zeroed for the
    //       chips-to-pot animation), all 4 mucked cards become voluntarily
    //       shown via the endHand bot-reveal pass.
    // The mid-hand-leak guard is what protects multi-bot tables where a
    // bot folding preflop must not expose its hand for the rest of the
    // hand to the other contestants.
    const states: ServerGameState[] = [];
    const seats = [
      { seatIndex: 0, userId: 'bot1', username: 'StackBot', displayName: 'StackBot',
        avatarId: 'avatar_1', stack: 1000, status: 'WAITING' as const,
        timeBank: 30, isConnected: true, isBot: true },
      { seatIndex: 1, userId: 'p2',   username: 'p2',       displayName: 'p2',
        avatarId: 'avatar_1', stack: 1000, status: 'WAITING' as const,
        timeBank: 30, isConnected: true },
    ];
    const engine = new PokerGameEngine(
      'plo-bot-fold', seats, 10, 20,
      (s) => states.push(JSON.parse(JSON.stringify(s))), () => {}, 'PLO',
    );
    engine.startHand();

    // Walk the action surface until the bot is active, then have it fold.
    // HU preflop button assignment varies; we just want the bot to be the
    // one folding.
    let guard = 0;
    while (engine.getState().activePlayerId !== 'bot1' && guard < 5) {
      const active = engine.getState().activePlayerId!;
      const r = engine.processAction(active, 'CALL');
      expect(r.ok).toBe(true);
      guard++;
    }
    expect(engine.getState().activePlayerId).toBe('bot1');
    const r = engine.processAction('bot1', 'FOLD');
    expect(r.ok).toBe(true);

    // (a) Mid-hand-leak guard: immediately after the fold, before the
    // CLOSE_ROUND_DELAY timer fires `endHand`, the bot's cards must still
    // be hidden. `voluntaryShownCardIndices` is the field `buildClientView`
    // reads to populate `revealedCards`, so an empty array == cards stay
    // face-down on every client.
    const botMidHand = engine.getState().seats.find(s => s.userId === 'bot1')!;
    expect(botMidHand.status).toBe('FOLDED');
    expect(botMidHand.mucked).toHaveLength(4);
    expect(botMidHand.voluntaryShownCardIndices).toEqual([]);

    // (b) Drive the deferred `endHand` (HU fold → uncontested winner;
    // blinds were posted so visible-bets path schedules endHand via
    // setTimeout(CLOSE_ROUND_DELAY_MS)). After it runs, the bot-reveal
    // loop inside endHand populates the indices.
    jest.advanceTimersByTime(1000);
    const botEnd = engine.getState().seats.find(s => s.userId === 'bot1')!;
    expect(botEnd.voluntaryShownCardIndices).toEqual([0, 1, 2, 3]);
  });

  // ─── Chip conservation ──────────────────────────────────────────────────

  test('20 hands of PLO heads-up: chip total is preserved', () => {
    const { engine, states } = makePLOEngine(2, [2000, 2000]);
    const initialTotal = 4000;
    engine.startHand();

    let hands = 0;
    while (hands < 20 && engine.getState().phase === 'BETTING') {
      // Drain hand: play CHECK / CALL only (avoids busts in the audit window).
      let guard = 0;
      while (engine.getState().phase === 'BETTING' && guard < 200) {
        const st = engine.getState();
        if (!st.activePlayerId) { jest.advanceTimersByTime(800); guard++; continue; }
        const legal = engine.getLegalActions(st.activePlayerId);
        const check = legal.find(a => a.action === 'CHECK');
        const call  = legal.find(a => a.action === 'CALL');
        const action: ActionType = check ? 'CHECK' : call ? 'CALL' : 'FOLD';
        engine.processAction(st.activePlayerId, action);
        jest.advanceTimersByTime(800);
        guard++;
      }
      jest.advanceTimersByTime(7000); // HAND_START_DELAY
      hands++;
    }

    expect(hands).toBeGreaterThan(1);
    // Final snapshot — stack + still-committed contributions must total
    // initial bank.
    const f = engine.getState();
    expect(f.seats.reduce((s, x) => s + x.stack + x.totalContributed, 0))
      .toBe(initialTotal);

    // Every emitted state should also pass the no-negative-stack rule and
    // never have a hole card count != 4 for dealt seats.
    for (const s of states) {
      for (const seat of s.seats) {
        expect(seat.stack).toBeGreaterThanOrEqual(0);
        if (seat.status === 'ACTIVE' || seat.status === 'ALL_IN') {
          expect(seat.holeCards.length === 4 || seat.holeCards.length === 0).toBe(true);
        }
      }
    }
  });
});
