// ─── Card Primitives ──────────────────────────────────────────────────────────

// CSPRNG for the deck shuffle. `Math.random()` (V8's xorshift128+) is
// reversible from ~5 observed outputs — for a poker app, that means a single
// played hand's worth of cards is enough for an attacker to reconstruct
// internal state and predict every subsequent shuffle. `crypto.randomInt`
// uses the OS entropy source and is unbiased over [0, max). ~10x slower than
// Math.random, which is irrelevant — we shuffle once per hand.
import { randomInt } from 'crypto';

export type Suit = 'S' | 'H' | 'D' | 'C';
export type Rank = '2'|'3'|'4'|'5'|'6'|'7'|'8'|'9'|'T'|'J'|'Q'|'K'|'A';

export interface Card {
  rank: Rank;
  suit: Suit;
}

export const SUITS: Suit[] = ['S','H','D','C'];
export const RANKS: Rank[] = ['2','3','4','5','6','7','8','9','T','J','Q','K','A'];

export const RANK_VALUE: Record<Rank, number> = {
  '2':2,'3':3,'4':4,'5':5,'6':6,'7':7,'8':8,'9':9,
  'T':10,'J':11,'Q':12,'K':13,'A':14
};

export function cardKey(c: Card): string { return `${c.rank}${c.suit}`; }

export function parseCard(key: string): Card {
  return { rank: key[0] as Rank, suit: key[1] as Suit };
}

// Cryptographically fair Fisher-Yates shuffle. The randomness source is the
// OS CSPRNG via `randomInt` — this is what makes the shuffle unpredictable to
// an attacker who has observed prior hands. See the import block at the top
// of this file for the full rationale.
export function buildDeck(): Card[] {
  const deck: Card[] = [];
  for (const suit of SUITS) {
    for (const rank of RANKS) {
      deck.push({ rank, suit });
    }
  }
  // Fisher-Yates with a CSPRNG-backed integer in [0, i+1). `randomInt` is
  // already unbiased (rejection-sampled internally), so no manual mod-bias
  // workaround is needed.
  for (let i = deck.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}

export function cardLabel(c: Card): string {
  const rankLabel: Record<Rank, string> = {
    '2':'2','3':'3','4':'4','5':'5','6':'6','7':'7','8':'8','9':'9',
    'T':'10','J':'J','Q':'Q','K':'K','A':'A'
  };
  const suitLabel: Record<Suit, string> = { 'S':'♠','H':'♥','D':'♦','C':'♣' };
  return `${rankLabel[c.rank]}${suitLabel[c.suit]}`;
}
