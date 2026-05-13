// Standalone PLO debug — walks through every street of a heads-up PLO
// hand and prints the active player's legal actions at each step, so we
// can verify the action-bar surface (FOLD/CHECK/CALL/RAISE/ALL_IN) is
// what iOS should be receiving. Run with: npx ts-node scripts/plo_debug.ts
import { PokerGameEngine } from '../src/game/gameEngine';

function makeSeat(userId: string, seatIndex: number, stack = 1000) {
  return {
    seatIndex, userId, username: userId, displayName: userId,
    avatarId: 'a1', stack, status: 'WAITING' as const,
    timeBank: 0, isConnected: true,
  };
}

function dump(label: string, engine: PokerGameEngine) {
  const st = engine.getState();
  console.log(`\n==== ${label} ====`);
  console.log(`street=${st.street} phase=${st.phase} currentBet=${st.currentBet} minRaise=${st.minRaise} activePlayer=${st.activePlayerId}`);
  for (const s of st.seats) {
    console.log(`  seat${s.seatIndex} ${s.userId} stack=${s.stack} bet=${s.betThisStreet} status=${s.status} holes=${s.holeCards.length}`);
  }
  if (st.activePlayerId) {
    const la = engine.getLegalActions(st.activePlayerId);
    console.log(`  legalActions: ${JSON.stringify(la)}`);
    const names = la.map(a => a.action).sort();
    const hasRaise = names.includes('RAISE');
    console.log(`  -> hasRAISE=${hasRaise} (actions: ${names.join(',')})`);
  }
}

function step(engine: PokerGameEngine, action: 'CHECK' | 'CALL' | 'FOLD') {
  const st = engine.getState();
  const r = engine.processAction(st.activePlayerId!, action);
  if (!r.ok) console.log(`  !! ${action} failed: ${(r as any).error}`);
}

// ─── Heads-up PLO walkthrough ────────────────────────────────────────────────
{
  const engine = new PokerGameEngine(
    'plo-headsup',
    [makeSeat('p1', 0, 1000), makeSeat('p2', 1, 1000)],
    10, 20,
    () => {},
    () => {},
    'PLO',
  );
  engine.startHand();
  dump('PLO HU preflop — SB to act', engine);

  // SB calls 10 -> BB option
  step(engine, 'CALL');
  dump('PLO HU preflop — BB option after SB calls', engine);

  // BB checks -> flop
  step(engine, 'CHECK');
  dump('PLO HU FLOP — first to act', engine);

  // Check around through flop
  step(engine, 'CHECK');
  dump('PLO HU FLOP — second checks -> TURN', engine);

  step(engine, 'CHECK');
  dump('PLO HU TURN — first checks', engine);

  step(engine, 'CHECK');
  dump('PLO HU TURN -> RIVER', engine);

  step(engine, 'CHECK');
  dump('PLO HU RIVER — first checks', engine);
}

// ─── 3-player PLO walkthrough ────────────────────────────────────────────────
{
  const engine = new PokerGameEngine(
    'plo-3max',
    [
      makeSeat('p1', 0, 1000),
      makeSeat('p2', 1, 1000),
      makeSeat('p3', 2, 1000),
    ],
    10, 20,
    () => {},
    () => {},
    'PLO',
  );
  engine.startHand();
  dump('PLO 3-max preflop — UTG (BTN) to act', engine);

  step(engine, 'CALL');
  dump('PLO 3-max preflop — SB to act', engine);

  step(engine, 'CALL');
  dump('PLO 3-max preflop — BB option', engine);

  step(engine, 'CHECK');
  dump('PLO 3-max FLOP — first to act', engine);
}

process.exit(0);
