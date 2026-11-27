import { describe, expect, it } from 'vitest';
import { distributePlayers } from '../src/shared/distribute.js';
import { buildCommunityLeaderboard } from '../src/shared/leaderboard.js';

describe('distributePlayers', () => {
  it('assigns every player exactly once with balanced group sizes', () => {
    const players = Array.from({ length: 11 }, (_, i) => `Player ${i + 1}`);
    const sets = distributePlayers(players, 4);
    const assigned = sets.flatMap((set) => set.players);
    expect(assigned).toHaveLength(players.length);
    expect(new Set(assigned)).toEqual(new Set(players));
    expect(Math.max(...sets.map((set) => set.players.length)) - Math.min(...sets.map((set) => set.players.length))).toBeLessThanOrEqual(1);
  });
  it('rejects invalid group sizes', () => expect(() => distributePlayers(['A', 'B'], 1)).toThrow());
});

describe('buildCommunityLeaderboard', () => {
  it('counts a win for every player on the winning team', () => {
    const rows = buildCommunityLeaderboard([{ winning_team_id: 2, teams: [
      { id: 1, players: [{ id: 'a', name: 'A' }] },
      { id: 2, players: [{ id: 'b', name: 'B' }, { id: 'c', name: 'C' }] },
    ] }]);
    expect(rows.find((row) => row.memberId === 'b')?.wins).toBe(1);
    expect(rows.find((row) => row.memberId === 'a')?.losses).toBe(1);
  });
});
