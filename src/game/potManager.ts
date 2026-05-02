// ─── Pot Manager ─────────────────────────────────────────────────────────────
// Handles main pots, side pots, and chip distribution for all-in situations.

export interface PotSlice {
  amount: number;
  eligiblePlayerIds: string[];
  isMain: boolean;
}

export interface PlayerContribution {
  playerId: string;
  totalContributed: number;   // total chips put into pot this hand
  isAllIn: boolean;
  isActive: boolean;          // still in (not folded)
}

/**
 * Build side pots from player contributions.
 *
 * Example: Players A(all-in 50), B(100), C(100)
 *   → Main pot:  150 (50×3), eligible: A,B,C
 *   → Side pot:  100 (50×2), eligible: B,C
 */
export function buildPots(contributions: PlayerContribution[]): PotSlice[] {
  // Only include players who put chips in
  const active = contributions.filter(p => p.totalContributed > 0);
  if (active.length === 0) return [];

  const pots: PotSlice[] = [];
  // Work through contribution levels from smallest to largest
  const levels = [...new Set(
    active
      .filter(p => p.isAllIn)
      .map(p => p.totalContributed)
  )].sort((a, b) => a - b);

  let remaining = active.map(p => ({ ...p }));
  let prevLevel = 0;

  for (const level of levels) {
    const diff = level - prevLevel;
    if (diff <= 0) continue;

    const eligible   = remaining.filter(p => p.totalContributed >= level && p.isActive);
    const potAmount  = remaining.reduce((sum, p) => sum + Math.min(Math.max(p.totalContributed - prevLevel, 0), diff), 0);

    if (potAmount > 0) {
      pots.push({
        amount: potAmount,
        eligiblePlayerIds: eligible.map(p => p.playerId),
        isMain: pots.length === 0,
      });
    }
    prevLevel = level;
  }

  // Remaining chips above all all-in levels
  const residual = remaining.reduce((sum, p) => sum + Math.max(p.totalContributed - prevLevel, 0), 0);
  if (residual > 0) {
    const eligible = remaining.filter(p => p.totalContributed > prevLevel && p.isActive);
    pots.push({
      amount: residual,
      eligiblePlayerIds: eligible.map(p => p.playerId),
      isMain: pots.length === 0,
    });
  }

  // If no all-ins, single pot with all active players
  if (pots.length === 0) {
    const totalPot = active.reduce((s, p) => s + p.totalContributed, 0);
    pots.push({
      amount: totalPot,
      eligiblePlayerIds: active.filter(p => p.isActive).map(p => p.playerId),
      isMain: true,
    });
  }

  return pots;
}

export interface PayoutResult {
  playerId: string;
  amount: number;
  potDescription: string;
}

/**
 * Distribute pots to winners.
 * winnersByPot: map of potIndex -> winning playerIds (from hand evaluator)
 * Returns per-player chip payouts.
 */
export function distributePots(
  pots: PotSlice[],
  winnersByPot: Map<number, string[]>
): PayoutResult[] {
  const payouts = new Map<string, number>();

  for (let i = 0; i < pots.length; i++) {
    const pot     = pots[i];
    const winners = winnersByPot.get(i) ?? [];
    if (winners.length === 0) continue;

    // Split pot evenly; remainder goes to earliest position winner
    const share    = Math.floor(pot.amount / winners.length);
    const remainder = pot.amount - share * winners.length;

    for (let j = 0; j < winners.length; j++) {
      const pid    = winners[j];
      const amount = share + (j === 0 ? remainder : 0);
      payouts.set(pid, (payouts.get(pid) ?? 0) + amount);
    }
  }

  return [...payouts.entries()].map(([playerId, amount]) => ({
    playerId,
    amount,
    potDescription: pots.length > 1 ? 'Pot split' : 'Main pot',
  }));
}

export function totalPot(pots: PotSlice[]): number {
  return pots.reduce((s, p) => s + p.amount, 0);
}
