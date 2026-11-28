export type RotationOutcome = 'TEAM_A_WIN' | 'TEAM_B_WIN' | 'DRAW';
export type RotationGoal = {
  teamId: number;
  scorerId: string;
  scorerName: string;
  assisterId: string | null;
  assisterName: string | null;
  scoredAt: string;
};
export type RotationSnapshot = {
  activeTeamIds: [number, number];
  waitingTeamIds: number[];
  score?: [number, number];
  goals?: RotationGoal[];
  timerStartedAt?: string;
  timerPausedAt?: string | null;
  pausedRemainingMs?: number | null;
};
export type RotationGame = {
  number: number;
  teamAId: number;
  teamBId: number;
  outcome: RotationOutcome;
  winnerTeamId: number | null;
  playedAt: string;
  previousState: RotationSnapshot;
  goals?: RotationGoal[];
  score?: [number, number];
};
export type RotationState = RotationSnapshot & {
  status: 'ACTIVE' | 'ENDED';
  games: RotationGame[];
  goalsToWin?: number;
  durationSeconds?: number;
};
export type RotationOptions = { goalsToWin?: number; durationSeconds?: number };

export function createRotationState(teamIds: number[], options: RotationOptions = {}, startedAt = new Date().toISOString()): RotationState {
  if (teamIds.length < 2 || new Set(teamIds).size !== teamIds.length) {
    throw new Error('A rotation needs at least two distinct teams.');
  }
  const goalsToWin = options.goalsToWin ?? 1;
  const durationSeconds = options.durationSeconds ?? 600;
  if (!Number.isInteger(goalsToWin) || goalsToWin < 1 || goalsToWin > 5) throw new Error('The goal target must be between 1 and 5.');
  if (!Number.isInteger(durationSeconds) || durationSeconds < 60 || durationSeconds > 3600) throw new Error('Match duration must be between 1 and 60 minutes.');
  return {
    status: 'ACTIVE',
    activeTeamIds: [teamIds[0], teamIds[1]],
    waitingTeamIds: teamIds.slice(2),
    games: [],
    goalsToWin,
    durationSeconds,
    score: [0, 0],
    goals: [],
    timerStartedAt: startedAt,
    timerPausedAt: null,
    pausedRemainingMs: null,
  };
}

function snapshot(state: RotationState): RotationSnapshot {
  return {
    activeTeamIds: [...state.activeTeamIds] as [number, number],
    waitingTeamIds: [...state.waitingTeamIds],
    score: [...(state.score ?? [0, 0])] as [number, number],
    goals: [...(state.goals ?? [])],
    timerStartedAt: state.timerStartedAt,
    timerPausedAt: state.timerPausedAt ?? null,
    pausedRemainingMs: state.pausedRemainingMs ?? null,
  };
}

export function remainingTimeMs(state: RotationState, now = new Date()): number {
  const durationMs = (state.durationSeconds ?? 600) * 1000;
  if (state.timerPausedAt) return Math.max(0, state.pausedRemainingMs ?? durationMs);
  if (!state.timerStartedAt) return durationMs;
  return Math.max(0, durationMs - (now.getTime() - new Date(state.timerStartedAt).getTime()));
}

function finishGame(state: RotationState, outcome: RotationOutcome, playedAt: string): RotationState {
  if (state.status !== 'ACTIVE') throw new Error('This rotation is not active.');
  const [teamAId, teamBId] = state.activeTeamIds;
  if (teamAId === undefined || teamBId === undefined) throw new Error('Two active teams are required.');
  const previousState = { ...snapshot(state), score: [0, 0] as [number, number], goals: [] };
  const goals = [...(state.goals ?? [])];
  const score = [...(state.score ?? [0, 0])] as [number, number];
  const game: RotationGame = {
    number: state.games.length + 1, teamAId, teamBId, outcome,
    winnerTeamId: outcome === 'TEAM_A_WIN' ? teamAId : outcome === 'TEAM_B_WIN' ? teamBId : null,
    playedAt, previousState, goals, score,
  };
  const games = [...state.games, game];
  const reset = { score: [0, 0] as [number, number], goals: [] as RotationGoal[], timerStartedAt: playedAt, timerPausedAt: null, pausedRemainingMs: null };
  if (outcome === 'DRAW') {
    const queue = [...state.waitingTeamIds, teamAId, teamBId];
    const nextActive = queue.splice(0, 2);
    return { ...state, ...reset, status: 'ACTIVE', activeTeamIds: nextActive as [number, number], waitingTeamIds: queue, games };
  }
  const winnerTeamId = outcome === 'TEAM_A_WIN' ? teamAId : teamBId;
  const loserTeamId = outcome === 'TEAM_A_WIN' ? teamBId : teamAId;
  const queue = [...state.waitingTeamIds, loserTeamId];
  const nextChallenger = queue.shift();
  if (nextChallenger === undefined) throw new Error('No challenger is available.');
  return { ...state, ...reset, status: 'ACTIVE', activeTeamIds: [winnerTeamId, nextChallenger], waitingTeamIds: queue, games };
}

export function recordRotationResult(state: RotationState, outcome: RotationOutcome, playedAt = new Date().toISOString()): RotationState {
  return finishGame(state, outcome, playedAt);
}

export function recordRotationGoal(
  state: RotationState,
  goal: Omit<RotationGoal, 'scoredAt'>,
  now = new Date(),
): RotationState {
  if (state.status !== 'ACTIVE') throw new Error('This rotation is not active.');
  if (remainingTimeMs(state, now) <= 0) return expireRotationTimer(state, now);
  const [teamAId, teamBId] = state.activeTeamIds;
  if (goal.teamId !== teamAId && goal.teamId !== teamBId) throw new Error('The scoring team must be one of the active teams.');
  if (goal.assisterId && goal.assisterId === goal.scorerId) throw new Error('A player cannot assist their own goal.');
  const score = [...(state.score ?? [0, 0])] as [number, number];
  const index = goal.teamId === teamAId ? 0 : 1;
  score[index] += 1;
  const goals = [...(state.goals ?? []), { ...goal, scoredAt: now.toISOString() }];
  const updated = { ...state, score, goals };
  if (score[index] >= (state.goalsToWin ?? 1)) return finishGame(updated, index === 0 ? 'TEAM_A_WIN' : 'TEAM_B_WIN', now.toISOString());
  return updated;
}

export function expireRotationTimer(state: RotationState, now = new Date()): RotationState {
  if (state.status !== 'ACTIVE' || remainingTimeMs(state, now) > 0) return state;
  const [scoreA, scoreB] = state.score ?? [0, 0];
  return finishGame(state, scoreA === scoreB ? 'DRAW' : scoreA > scoreB ? 'TEAM_A_WIN' : 'TEAM_B_WIN', now.toISOString());
}

export function pauseRotationTimer(state: RotationState, now = new Date()): RotationState {
  if (state.status !== 'ACTIVE') throw new Error('This rotation is not active.');
  if (state.timerPausedAt) return state;
  return { ...state, timerPausedAt: now.toISOString(), pausedRemainingMs: remainingTimeMs(state, now) };
}

export function resumeRotationTimer(state: RotationState, now = new Date()): RotationState {
  if (state.status !== 'ACTIVE') throw new Error('This rotation is not active.');
  if (!state.timerPausedAt) return state;
  const remaining = Math.max(0, state.pausedRemainingMs ?? 0);
  return { ...state, timerStartedAt: new Date(now.getTime() - ((state.durationSeconds ?? 600) * 1000 - remaining)).toISOString(), timerPausedAt: null, pausedRemainingMs: null };
}

export function undoRotationResult(state: RotationState): RotationState {
  const lastGame = state.games.at(-1);
  if (!lastGame) throw new Error('There is no result to undo.');
  return {
    ...state,
    status: 'ACTIVE',
    activeTeamIds: [...lastGame.previousState.activeTeamIds] as [number, number],
    waitingTeamIds: [...lastGame.previousState.waitingTeamIds],
    score: [...(lastGame.previousState.score ?? [0, 0])] as [number, number],
    goals: [...(lastGame.previousState.goals ?? [])],
    timerStartedAt: lastGame.previousState.timerStartedAt,
    timerPausedAt: lastGame.previousState.timerPausedAt ?? null,
    pausedRemainingMs: lastGame.previousState.pausedRemainingMs ?? null,
    games: state.games.slice(0, -1),
  };
}
