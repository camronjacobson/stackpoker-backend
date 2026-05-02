import { evaluateHand, compareHands, HandRank, determineWinners } from '../src/game/handEvaluator';
import { Card } from '../src/game/deck';

function c(rank: string, suit: string): Card {
  return { rank: rank as any, suit: suit as any };
}

describe('Hand Evaluator', () => {

  // ─── Basic hand ranks ──────────────────────────────────────────────────────

  test('Royal Flush', () => {
    const hand = evaluateHand([c('A','S'), c('K','S'), c('Q','S'), c('J','S'), c('T','S'), c('2','H'), c('3','D')]);
    expect(hand.rank).toBe(HandRank.ROYAL_FLUSH);
  });

  test('Straight Flush', () => {
    const hand = evaluateHand([c('9','H'), c('8','H'), c('7','H'), c('6','H'), c('5','H'), c('A','S'), c('K','D')]);
    expect(hand.rank).toBe(HandRank.STRAIGHT_FLUSH);
    expect(hand.tiebreakers[0]).toBe(9);
  });

  test('Four of a Kind', () => {
    const hand = evaluateHand([c('A','S'), c('A','H'), c('A','D'), c('A','C'), c('K','S'), c('2','H'), c('3','D')]);
    expect(hand.rank).toBe(HandRank.FOUR_OF_A_KIND);
    expect(hand.tiebreakers[0]).toBe(14); // Aces
  });

  test('Full House', () => {
    const hand = evaluateHand([c('K','S'), c('K','H'), c('K','D'), c('Q','C'), c('Q','S'), c('2','H'), c('3','D')]);
    expect(hand.rank).toBe(HandRank.FULL_HOUSE);
    expect(hand.tiebreakers[0]).toBe(13); // Kings full of Queens
    expect(hand.tiebreakers[1]).toBe(12);
  });

  test('Flush', () => {
    const hand = evaluateHand([c('A','H'), c('T','H'), c('8','H'), c('5','H'), c('3','H'), c('K','S'), c('2','D')]);
    expect(hand.rank).toBe(HandRank.FLUSH);
  });

  test('Straight', () => {
    const hand = evaluateHand([c('9','S'), c('8','H'), c('7','D'), c('6','C'), c('5','S'), c('A','H'), c('K','D')]);
    expect(hand.rank).toBe(HandRank.STRAIGHT);
    expect(hand.tiebreakers[0]).toBe(9);
  });

  test('Wheel (A-2-3-4-5 straight)', () => {
    const hand = evaluateHand([c('A','S'), c('2','H'), c('3','D'), c('4','C'), c('5','S'), c('K','H'), c('Q','D')]);
    expect(hand.rank).toBe(HandRank.STRAIGHT);
    expect(hand.tiebreakers[0]).toBe(5); // Five-high straight
  });

  test('Three of a Kind', () => {
    const hand = evaluateHand([c('7','S'), c('7','H'), c('7','D'), c('K','C'), c('Q','S'), c('2','H'), c('3','D')]);
    expect(hand.rank).toBe(HandRank.THREE_OF_A_KIND);
    expect(hand.tiebreakers[0]).toBe(7);
  });

  test('Two Pair', () => {
    const hand = evaluateHand([c('A','S'), c('A','H'), c('K','D'), c('K','C'), c('Q','S'), c('2','H'), c('3','D')]);
    expect(hand.rank).toBe(HandRank.TWO_PAIR);
    expect(hand.tiebreakers[0]).toBe(14); // Aces and Kings
    expect(hand.tiebreakers[1]).toBe(13);
  });

  test('One Pair', () => {
    const hand = evaluateHand([c('A','S'), c('A','H'), c('K','D'), c('Q','C'), c('J','S'), c('9','H'), c('8','D')]);
    expect(hand.rank).toBe(HandRank.ONE_PAIR);
    expect(hand.tiebreakers[0]).toBe(14);
  });

  test('High Card', () => {
    const hand = evaluateHand([c('A','S'), c('K','H'), c('J','D'), c('9','C'), c('7','S'), c('5','H'), c('3','D')]);
    expect(hand.rank).toBe(HandRank.HIGH_CARD);
    expect(hand.tiebreakers[0]).toBe(14);
  });

  // ─── Comparison ────────────────────────────────────────────────────────────

  test('Flush beats Straight', () => {
    const flush    = evaluateHand([c('A','H'), c('T','H'), c('8','H'), c('5','H'), c('3','H'), c('K','S'), c('Q','D')]);
    const straight = evaluateHand([c('9','S'), c('8','H'), c('7','D'), c('6','C'), c('5','S'), c('A','H'), c('K','D')]);
    expect(compareHands(flush, straight)).toBeGreaterThan(0);
  });

  test('Higher pair beats lower pair', () => {
    const pairAces  = evaluateHand([c('A','S'), c('A','H'), c('2','D'), c('3','C'), c('4','S'), c('5','H'), c('6','D')]);
    const pairKings = evaluateHand([c('K','S'), c('K','H'), c('2','D'), c('3','C'), c('4','S'), c('5','H'), c('6','D')]);
    expect(compareHands(pairAces, pairKings)).toBeGreaterThan(0);
  });

  test('Kicker breaks tie', () => {
    const pairAceKing = evaluateHand([c('A','S'), c('A','H'), c('K','D'), c('3','C'), c('4','S'), c('5','H'), c('6','D')]);
    const pairAceQueen = evaluateHand([c('A','S'), c('A','H'), c('Q','D'), c('3','C'), c('4','S'), c('5','H'), c('6','D')]);
    expect(compareHands(pairAceKing, pairAceQueen)).toBeGreaterThan(0);
  });

  test('Exact tie returns 0', () => {
    const handA = evaluateHand([c('A','S'), c('K','H'), c('Q','D'), c('J','C'), c('9','S'), c('8','H'), c('7','D')]);
    const handB = evaluateHand([c('A','H'), c('K','D'), c('Q','C'), c('J','S'), c('9','H'), c('8','D'), c('7','C')]);
    expect(compareHands(handA, handB)).toBe(0);
  });

  // ─── Winner determination ──────────────────────────────────────────────────

  test('Single winner', () => {
    const players = [
      { playerId: 'p1', holeCards: [c('A','S'), c('A','H')], hand: evaluateHand([c('A','S'), c('A','H'), c('K','D'), c('Q','C'), c('J','S'), c('9','H'), c('8','D')]) },
      { playerId: 'p2', holeCards: [c('2','S'), c('3','H')], hand: evaluateHand([c('2','S'), c('3','H'), c('K','D'), c('Q','C'), c('J','S'), c('9','H'), c('8','D')]) },
    ];
    const result = determineWinners(players);
    expect(result.winners).toEqual(['p1']);
  });

  test('Split pot on tie', () => {
    // Both players have the same best hand from the board
    const board = [c('A','S'), c('K','H'), c('Q','D'), c('J','C'), c('T','S')];
    const players = [
      { playerId: 'p1', holeCards: [c('2','H'), c('3','H')], hand: evaluateHand([c('2','H'), c('3','H'), ...board]) },
      { playerId: 'p2', holeCards: [c('4','D'), c('5','D')], hand: evaluateHand([c('4','D'), c('5','D'), ...board]) },
    ];
    const result = determineWinners(players);
    // Both play the board — Royal Flush split
    expect(result.winners).toContain('p1');
    expect(result.winners).toContain('p2');
  });

  test('Three-way: best hand wins', () => {
    const board = [c('K','S'), c('K','H'), c('2','D'), c('3','C'), c('7','S')];
    const players = [
      { playerId: 'p1', holeCards: [c('K','D'), c('K','C')],  hand: evaluateHand([c('K','D'), c('K','C'),  ...board]) }, // quads
      { playerId: 'p2', holeCards: [c('K','D'), c('A','C')],  hand: evaluateHand([c('A','S'), c('A','H'),  ...board]) }, // full house
      { playerId: 'p3', holeCards: [c('Q','H'), c('J','H')],  hand: evaluateHand([c('Q','H'), c('J','H'),  ...board]) }, // pair
    ];
    const result = determineWinners(players);
    expect(result.winners).toEqual(['p1']);
  });
});
