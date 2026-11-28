export type TeamPlayer = { id: string; name: string };
export type TeamRecord = { id: number; players: TeamPlayer[] };
export type RotationLeaderboardGame = { teamAId: number; teamBId: number; outcome: 'TEAM_A_WIN' | 'TEAM_B_WIN' | 'DRAW' };
export type CompletedMatch = {
  teams: TeamRecord[];
  winning_team_id: number | null;
  rotation_state?: { games?: RotationLeaderboardGame[] } | null;
};
export type LeaderboardRow = {
  memberId: string;
  name: string;
  wins: number;
  losses: number;
  draws: number;
  matchesPlayed: number;
  winRate: number;
};

export function buildCommunityLeaderboard(matches: CompletedMatch[]): LeaderboardRow[] {
  const stats = new Map<string, { memberId: string; name: string; wins: number; losses: number; draws: number; matchesPlayed: number }>();
  const apply = (team: TeamRecord, outcome: 'WIN' | 'LOSS' | 'DRAW') => {
    for (const player of team.players) {
      const current = stats.get(player.id) || { memberId: player.id, name: player.name, wins: 0, losses: 0, draws: 0, matchesPlayed: 0 };
      current.matchesPlayed += 1;
      if (outcome === 'WIN') current.wins += 1;
      if (outcome === 'LOSS') current.losses += 1;
      if (outcome === 'DRAW') current.draws += 1;
      stats.set(player.id, current);
    }
  };

  for (const match of matches) {
    if (match.rotation_state?.games) {
      for (const game of match.rotation_state.games) {
        const teamA = match.teams.find((team) => team.id === game.teamAId);
        const teamB = match.teams.find((team) => team.id === game.teamBId);
        if (!teamA || !teamB) continue;
        if (game.outcome === 'DRAW') {
          apply(teamA, 'DRAW');
          apply(teamB, 'DRAW');
        } else if (game.outcome === 'TEAM_A_WIN') {
          apply(teamA, 'WIN');
          apply(teamB, 'LOSS');
        } else {
          apply(teamA, 'LOSS');
          apply(teamB, 'WIN');
        }
      }
      continue;
    }
    if (match.winning_team_id === null) continue;
    for (const team of match.teams) apply(team, match.winning_team_id === team.id ? 'WIN' : 'LOSS');
  }

  return [...stats.values()]
    .map((item) => ({
      ...item,
      winRate: item.matchesPlayed ? Math.round((item.wins / item.matchesPlayed) * 100) : 0,
    }))
    .sort((a, b) => b.wins - a.wins || b.matchesPlayed - a.matchesPlayed || a.name.localeCompare(b.name));
}
