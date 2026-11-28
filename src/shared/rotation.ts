export type RotationOutcome = 'TEAM_A_WIN' | 'TEAM_B_WIN' | 'DRAW';
export type RotationSnapshot = { activeTeamIds: [number, number]; waitingTeamIds: number[] };
export type RotationGame = {
  number: number;
  teamAId: number;
  teamBId: number;
  outcome: RotationOutcome;
  winnerTeamId: number | null;
  playedAt: string;
  previousState: RotationSnapshot;
};
export type RotationState = RotationSnapshot & {
  status: 'ACTIVE' | 'ENDED';
  games: RotationGame[];
};

export function createRotationState(teamIds: number[]): RotationState {
  if (teamIds.length < 2 || new Set(teamIds).size !== teamIds.length) {
    throw new Error('A rotation needs at least two distinct teams.');
  }
  return {
    status: 'ACTIVE',
    activeTeamIds: [teamIds[0], teamIds[1]],
    waitingTeamIds: teamIds.slice(2),
    games: [],
  };
}

export function recordRotationResult(state: RotationState, outcome: RotationOutcome, playedAt = new Date().toISOString()): RotationState {
  if (state.status !== 'ACTIVE') throw new Error('This rotation is not active.');
  const [teamAId, teamBId] = state.activeTeamIds;
  if (!teamAId || !teamBId) throw new Error('Two active teams are required.');
  const previousState: RotationSnapshot = {
    activeTeamIds: [...state.activeTeamIds] as [number, number],
    waitingTeamIds: [...state.waitingTeamIds],
  };
  const games = [...state.games, {
    number: state.games.length + 1,
    teamAId,
    teamBId,
    outcome,
    winnerTeamId: outcome === 'TEAM_A_WIN' ? teamAId : outcome === 'TEAM_B_WIN' ? teamBId : null,
    playedAt,
    previousState,
  }];

  if (outcome === 'DRAW') {
    const queue = [...state.waitingTeamIds, teamAId, teamBId];
    const nextActive = queue.splice(0, 2);
    return { status: 'ACTIVE', activeTeamIds: nextActive as [number, number], waitingTeamIds: queue, games };
  }

  const winnerTeamId = outcome === 'TEAM_A_WIN' ? teamAId : teamBId;
  const loserTeamId = outcome === 'TEAM_A_WIN' ? teamBId : teamAId;
  const queue = [...state.waitingTeamIds, loserTeamId];
  const nextChallenger = queue.shift();
  if (nextChallenger === undefined) throw new Error('No challenger is available.');
  return {
    status: 'ACTIVE',
    activeTeamIds: [winnerTeamId, nextChallenger],
    waitingTeamIds: queue,
    games,
  };
}

export function undoRotationResult(state: RotationState): RotationState {
  const lastGame = state.games.at(-1);
  if (!lastGame) throw new Error('There is no result to undo.');
  return {
    status: 'ACTIVE',
    activeTeamIds: [...lastGame.previousState.activeTeamIds] as [number, number],
    waitingTeamIds: [...lastGame.previousState.waitingTeamIds],
    games: state.games.slice(0, -1),
  };
}
