// ─── Hand Evaluator ───────────────────────────────────────────────────────────
// Thin wrapper over `pokersolver` (https://github.com/goldfire/pokersolver).
// pokersolver is the standard Node hand evaluator: handles Hold'em + Omaha,
// covers every kicker / wheel / split-pot edge case, and is widely battle-
// tested. We delegate all evaluation + winner determination to it and adapt
// its output back to our existing `EvaluatedHand` / `WinnerResult` shapes so
// callers (gameEngine, bot heuristics) don't change.
//
// What we add on top of pokersolver:
//   • Strict input validation (5–7 cards for Hold'em, exactly 4 hole + 3–5
//     board for PLO, no duplicates).
//   • Royal-flush detection — pokersolver collapses Royal into "Straight
//     Flush" with `descr === 'Royal Flush'`, we promote it back.
//   • Wheel Ace normalisation — pokersolver returns Ace as `value: '1'` in
//     A-2-3-4-5 straights; we map it back to 'A'.
//   • A `compareHands` helper preserved for any future caller.

import { Card, Rank, Suit, RANK_VALUE } from './deck';

// pokersolver ships no @types; require() and treat the surface as `any`.
// Only `Hand.solve` and `Hand.winners` are used.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { Hand } = require('pokersolver');

// ─── Public types (UNCHANGED) ────────────────────────────────────────────────

export enum HandRank {
  HIGH_CARD       = 1,
  ONE_PAIR        = 2,
  TWO_PAIR        = 3,
  THREE_OF_A_KIND = 4,
  STRAIGHT        = 5,
  FLUSH           = 6,
  FULL_HOUSE      = 7,
  FOUR_OF_A_KIND  = 8,
  STRAIGHT_FLUSH  = 9,
  ROYAL_FLUSH     = 10,
}

export const HAND_NAMES: Record<HandRank, string> = {
  [HandRank.HIGH_CARD]:       'High Card',
  [HandRank.ONE_PAIR]:        'One Pair',
  [HandRank.TWO_PAIR]:        'Two Pair',
  [HandRank.THREE_OF_A_KIND]: 'Three of a Kind',
  [HandRank.STRAIGHT]:        'Straight',
  [HandRank.FLUSH]:           'Flush',
  [HandRank.FULL_HOUSE]:      'Full House',
  [HandRank.FOUR_OF_A_KIND]:  'Four of a Kind',
  [HandRank.STRAIGHT_FLUSH]:  'Straight Flush',
  [HandRank.ROYAL_FLUSH]:     'Royal Flush',
};

export interface EvaluatedHand {
  rank: HandRank;
  name: string;
  // Tiebreaker values in descending priority order (higher = better)
  tiebreakers: number[];
  // The 5 best cards
  bestCards: Card[];
}

export interface PlayerHandResult {
  playerId: string;
  hand: EvaluatedHand;
  holeCards: Card[];
}

export interface WinnerResult {
  winners: string[];       // playerIds (multiple = split pot)
  handName: string;
  bestHand: EvaluatedHand;
}

// ─── Card format adapters ────────────────────────────────────────────────────

// Our Card → pokersolver string ("Ah", "Ts", "2c"…). Suits lowercase.
function toSolverCard(c: Card): string {
  return `${c.rank}${c.suit.toLowerCase()}`;
}

// pokersolver card { value, suit } → our Card. Handles wheel-Ace ('1' → 'A').
function fromSolverCard(c: { value: string; suit: string }): Card {
  const rank = (c.value === '1' ? 'A' : c.value) as Rank;
  return { rank, suit: c.suit.toUpperCase() as Suit };
}

// pokersolver `name` (or `descr` for Royal) → our HandRank.
function solverNameToHandRank(name: string, descr: string): HandRank {
  switch (name) {
    case 'High Card':       return HandRank.HIGH_CARD;
    case 'Pair':            return HandRank.ONE_PAIR;
    case 'Two Pair':        return HandRank.TWO_PAIR;
    case 'Three of a Kind': return HandRank.THREE_OF_A_KIND;
    case 'Straight':        return HandRank.STRAIGHT;
    case 'Flush':           return HandRank.FLUSH;
    case 'Full House':      return HandRank.FULL_HOUSE;
    case 'Four of a Kind':  return HandRank.FOUR_OF_A_KIND;
    case 'Straight Flush':
      // Royal Flush is reported as Straight Flush with descr "Royal Flush".
      return descr === 'Royal Flush' ? HandRank.ROYAL_FLUSH : HandRank.STRAIGHT_FLUSH;
    default:
      throw new Error(`Unknown pokersolver hand name: ${name}`);
  }
}

function solverHandToEvaluated(hand: any): EvaluatedHand {
  const rank      = solverNameToHandRank(hand.name, hand.descr);
  const bestCards = (hand.cards as Array<{ value: string; suit: string }>)
    .map(fromSolverCard);
  // Tiebreakers: rank-values of the best 5 in pokersolver's significance order
  // (e.g. for Two Pair: [highPair, highPair, lowPair, lowPair, kicker]). The
  // first element is always the most significant card for that hand class —
  // gameEngine's bot heuristic depends on `tiebreakers[0]` being the pair /
  // trips / straight-top / flush-top rank.
  const tiebreakers = bestCards.map(c => RANK_VALUE[c.rank]);
  return { rank, name: HAND_NAMES[rank], tiebreakers, bestCards };
}

// ─── Validation ──────────────────────────────────────────────────────────────

function ensureUnique(cards: Card[]): void {
  const seen = new Set<string>();
  for (const c of cards) {
    const k = `${c.rank}${c.suit}`;
    if (seen.has(k)) throw new Error(`Duplicate card in evaluation input: ${k}`);
    seen.add(k);
  }
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Evaluate the best 5-card hand from 5–7 cards (typical: 2 hole + 5 community).
 * Throws on invalid input (wrong count, duplicate cards).
 */
export function evaluateHand(cards: Card[]): EvaluatedHand {
  if (cards.length < 5 || cards.length > 7) {
    throw new Error(`evaluateHand expects 5–7 cards, got ${cards.length}`);
  }
  ensureUnique(cards);
  const hand = Hand.solve(cards.map(toSolverCard));
  return solverHandToEvaluated(hand);
}

/**
 * Evaluate the best PLO hand. Pokersolver's 'omaha' mode enforces
 * "exactly 2 hole + exactly 3 board" natively.
 * Throws on invalid input (wrong counts, duplicate cards).
 */
export function evaluatePLOHand(holeCards: Card[], boardCards: Card[]): EvaluatedHand {
  if (holeCards.length !== 4) {
    throw new Error(`PLO expects exactly 4 hole cards, got ${holeCards.length}`);
  }
  if (boardCards.length < 3 || boardCards.length > 5) {
    throw new Error(`PLO expects 3–5 board cards, got ${boardCards.length}`);
  }
  ensureUnique([...holeCards, ...boardCards]);
  const all = [...holeCards, ...boardCards].map(toSolverCard);
  const hand = Hand.solve(all, 'omaha');
  return solverHandToEvaluated(hand);
}

/**
 * Compare two evaluated hands (positive = a beats b, 0 = tie).
 * Kept for callers; in-pot winner determination uses pokersolver's
 * `Hand.winners` directly via `determineWinners` below.
 */
export function compareHands(a: EvaluatedHand, b: EvaluatedHand): number {
  if (a.rank !== b.rank) return a.rank - b.rank;
  for (let i = 0; i < Math.max(a.tiebreakers.length, b.tiebreakers.length); i++) {
    const av = a.tiebreakers[i] ?? 0;
    const bv = b.tiebreakers[i] ?? 0;
    if (av !== bv) return av - bv;
  }
  return 0;
}

/**
 * Determine winners of a contested showdown. Delegates to
 * `pokersolver.Hand.winners`, which handles all kicker / split-pot edge
 * cases. Returns every winning playerId (multiple = chopped pot).
 */
export function determineWinners(players: PlayerHandResult[]): WinnerResult {
  if (players.length === 0) throw new Error('determineWinners called with no players');
  if (players.length === 1) {
    return {
      winners:  [players[0].playerId],
      handName: players[0].hand.name,
      bestHand: players[0].hand,
    };
  }

  // Re-solve from the cached best 5 so we have native pokersolver hand
  // objects; tag each with its playerId so we can map winners back.
  const solverHands: any[] = players.map(p => {
    const h = Hand.solve(p.hand.bestCards.map(toSolverCard));
    h._stackPlayerId = p.playerId;
    h._stackOriginal = p;
    return h;
  });

  const winningHands: any[] = Hand.winners(solverHands);
  const winnerIds  = winningHands.map(h => h._stackPlayerId as string);
  const bestSource = winningHands[0]._stackOriginal as PlayerHandResult;

  return {
    winners:  winnerIds,
    handName: bestSource.hand.name,
    bestHand: bestSource.hand,
  };
}
