import { describe, expect, it } from 'vitest';
import { createRotationState, recordRotationResult, undoRotationResult } from '../src/shared/rotation.js';

describe('winner-stays rotation', () => {
  it('starts with Set 1 against Set 2 and queues the remaining teams', () => {
    expect(createRotationState([1, 2, 3, 4])).toMatchObject({
      activeTeamIds: [1, 2], waitingTeamIds: [3, 4], games: [],
    });
  });

  it('keeps the winner on and brings in the next waiting team', () => {
    const state = recordRotationResult(createRotationState([1, 2, 3, 4]), 'TEAM_A_WIN', '2026-11-28T10:00:00.000Z');
    expect(state.activeTeamIds).toEqual([1, 3]);
    expect(state.waitingTeamIds).toEqual([4, 2]);
    expect(state.games[0]).toMatchObject({ teamAId: 1, teamBId: 2, winnerTeamId: 1 });
  });

  it('sends both teams to the back after a draw and brings in the next two', () => {
    const state = recordRotationResult(createRotationState([1, 2, 3, 4]), 'DRAW');
    expect(state.activeTeamIds).toEqual([3, 4]);
    expect(state.waitingTeamIds).toEqual([1, 2]);
    expect(state.games[0].winnerTeamId).toBeNull();
  });

  it('handles a two-team rotation without losing either team', () => {
    const state = recordRotationResult(createRotationState([1, 2]), 'TEAM_B_WIN');
    expect(state.activeTeamIds).toEqual([2, 1]);
    expect(state.waitingTeamIds).toEqual([]);
  });

  it('undo restores the exact previous lineup and queue', () => {
    const initial = createRotationState([1, 2, 3, 4]);
    const after = recordRotationResult(initial, 'TEAM_A_WIN');
    expect(undoRotationResult(after)).toEqual(initial);
  });

  it('supports multiple rotations and undoing only the latest result', () => {
    const first = recordRotationResult(createRotationState([1, 2, 3, 4]), 'TEAM_A_WIN');
    const second = recordRotationResult(first, 'DRAW');
    expect(second.activeTeamIds).toEqual([4, 2]);
    expect(undoRotationResult(second)).toEqual(first);
  });
});
