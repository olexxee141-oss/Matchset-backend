import { describe, expect, it } from 'vitest';
import { distributePlayers, distributeItems } from '../src/shared/distribute.js';
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
  it('retains distinct members who share the same display name', () => {
    const members = [
      { id: 'member-1', name: 'Alex' },
      { id: 'member-2', name: 'Alex' },
      { id: 'member-3', name: 'Sam' },
      { id: 'member-4', name: 'Sam' },
    ];
    const sets = distributeItems(members, 2);
    const assigned = sets.flatMap((set) => set.players);
    expect(assigned.map((member) => member.id).sort()).toEqual(members.map((member) => member.id).sort());
    expect(assigned.filter((member) => member.name === 'Alex')).toHaveLength(2);
  });
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

describe('rotation leaderboard', () => {
  it('counts wins, losses and draws from every recorded rotation game', () => {
    const rows = buildCommunityLeaderboard([{
      winning_team_id: null,
      teams: [
        { id: 1, players: [{ id: 'a', name: 'A' }] },
        { id: 2, players: [{ id: 'b', name: 'B' }] },
        { id: 3, players: [{ id: 'c', name: 'C' }] },
      ],
      rotation_state: { games: [
        { teamAId: 1, teamBId: 2, outcome: 'TEAM_A_WIN' },
        { teamAId: 1, teamBId: 3, outcome: 'DRAW' },
      ] },
    }]);
    expect(rows.find((row) => row.memberId === 'a')).toMatchObject({ wins: 1, losses: 0, draws: 1, matchesPlayed: 2 });
    expect(rows.find((row) => row.memberId === 'b')).toMatchObject({ wins: 0, losses: 1, draws: 0, matchesPlayed: 1 });
    expect(rows.find((row) => row.memberId === 'c')).toMatchObject({ wins: 0, losses: 0, draws: 1, matchesPlayed: 1 });
  });
});
