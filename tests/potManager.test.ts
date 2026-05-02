import { buildPots, distributePots, totalPot } from '../src/game/potManager';

describe('Pot Manager', () => {

  test('Single pot, no all-ins', () => {
    const contribs = [
      { playerId: 'p1', totalContributed: 100, isAllIn: false, isActive: true },
      { playerId: 'p2', totalContributed: 100, isAllIn: false, isActive: true },
      { playerId: 'p3', totalContributed: 100, isAllIn: false, isActive: true },
    ];
    const pots = buildPots(contribs);
    expect(pots).toHaveLength(1);
    expect(pots[0].amount).toBe(300);
    expect(pots[0].isMain).toBe(true);
    expect(pots[0].eligiblePlayerIds).toContain('p1');
    expect(pots[0].eligiblePlayerIds).toContain('p2');
    expect(pots[0].eligiblePlayerIds).toContain('p3');
  });

  test('Side pot: one all-in for less', () => {
    // p1 all-in for 50, p2 and p3 put in 100
    const contribs = [
      { playerId: 'p1', totalContributed: 50,  isAllIn: true,  isActive: true },
      { playerId: 'p2', totalContributed: 100, isAllIn: false, isActive: true },
      { playerId: 'p3', totalContributed: 100, isAllIn: false, isActive: true },
    ];
    const pots = buildPots(contribs);
    expect(pots).toHaveLength(2);
    // Main pot: 50 × 3 = 150
    expect(pots[0].amount).toBe(150);
    expect(pots[0].eligiblePlayerIds).toContain('p1');
    // Side pot: 50 × 2 = 100 (only p2 and p3 eligible)
    expect(pots[1].amount).toBe(100);
    expect(pots[1].eligiblePlayerIds).not.toContain('p1');
    expect(pots[1].eligiblePlayerIds).toContain('p2');
    expect(pots[1].eligiblePlayerIds).toContain('p3');
  });

  test('Multiple all-ins at different levels', () => {
    // p1: all-in 30, p2: all-in 60, p3: full 100, p4: full 100
    const contribs = [
      { playerId: 'p1', totalContributed: 30,  isAllIn: true,  isActive: true },
      { playerId: 'p2', totalContributed: 60,  isAllIn: true,  isActive: true },
      { playerId: 'p3', totalContributed: 100, isAllIn: false, isActive: true },
      { playerId: 'p4', totalContributed: 100, isAllIn: false, isActive: true },
    ];
    const pots = buildPots(contribs);
    // Pot 1: 30×4=120, all eligible
    // Pot 2: 30×3=90, p2/p3/p4 eligible
    // Pot 3: 40×2=80, p3/p4 eligible
    expect(totalPot(pots)).toBe(290);
  });

  test('Folded player excluded from pot', () => {
    const contribs = [
      { playerId: 'p1', totalContributed: 100, isAllIn: false, isActive: false }, // folded
      { playerId: 'p2', totalContributed: 100, isAllIn: false, isActive: true },
      { playerId: 'p3', totalContributed: 100, isAllIn: false, isActive: true },
    ];
    const pots = buildPots(contribs);
    // p1 contributed to pot but cannot win
    expect(pots[0].eligiblePlayerIds).not.toContain('p1');
    expect(pots[0].eligiblePlayerIds).toContain('p2');
    expect(pots[0].eligiblePlayerIds).toContain('p3');
    expect(pots[0].amount).toBe(300); // full pot still counts contributions
  });

  test('Distribute pot to single winner', () => {
    const pots = [{ amount: 300, eligiblePlayerIds: ['p1','p2','p3'], isMain: true }];
    const winnersByPot = new Map([[0, ['p1']]]);
    const payouts = distributePots(pots, winnersByPot);
    const p1 = payouts.find(p => p.playerId === 'p1');
    expect(p1?.amount).toBe(300);
  });

  test('Distribute split pot evenly', () => {
    const pots = [{ amount: 200, eligiblePlayerIds: ['p1','p2'], isMain: true }];
    const winnersByPot = new Map([[0, ['p1', 'p2']]]);
    const payouts = distributePots(pots, winnersByPot);
    expect(payouts.find(p => p.playerId === 'p1')?.amount).toBe(100);
    expect(payouts.find(p => p.playerId === 'p2')?.amount).toBe(100);
  });

  test('Odd chip goes to first winner', () => {
    const pots = [{ amount: 101, eligiblePlayerIds: ['p1','p2'], isMain: true }];
    const winnersByPot = new Map([[0, ['p1', 'p2']]]);
    const payouts = distributePots(pots, winnersByPot);
    const p1 = payouts.find(p => p.playerId === 'p1')?.amount ?? 0;
    const p2 = payouts.find(p => p.playerId === 'p2')?.amount ?? 0;
    expect(p1 + p2).toBe(101);
    expect(Math.abs(p1 - p2)).toBe(1);
  });

  test('Main and side pot distributed to different winners', () => {
    const pots = [
      { amount: 150, eligiblePlayerIds: ['p1','p2','p3'], isMain: true },
      { amount: 100, eligiblePlayerIds: ['p2','p3'],      isMain: false },
    ];
    const winnersByPot = new Map([
      [0, ['p1']],   // p1 wins main pot
      [1, ['p2']],   // p2 wins side pot
    ]);
    const payouts = distributePots(pots, winnersByPot);
    expect(payouts.find(p => p.playerId === 'p1')?.amount).toBe(150);
    expect(payouts.find(p => p.playerId === 'p2')?.amount).toBe(100);
    expect(payouts.find(p => p.playerId === 'p3')).toBeUndefined();
  });
});
