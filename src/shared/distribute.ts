export type PlayerSet<T = string> = { id: number; players: T[] };

export function distributeItems<T>(items: T[], playersPerSet: number): PlayerSet<T>[] {
  if (!Number.isInteger(playersPerSet) || playersPerSet < 2 || playersPerSet > 20) {
    throw new Error('Players per set must be between 2 and 20.');
  }
  if (items.length < 2) throw new Error('Add at least two players.');
  if (items.length > 500) throw new Error('A set can contain at most 500 players.');

  // Shuffle the original records, not their display names. IDs remain unambiguous
  // even when multiple community members use the same name.
  const players = [...items];
  for (let i = players.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [players[i], players[j]] = [players[j], players[i]];
  }
  const setCount = Math.ceil(players.length / playersPerSet);
  const sets: PlayerSet<T>[] = Array.from({ length: setCount }, (_, index) => ({ id: index + 1, players: [] }));
  players.forEach((player, index) => sets[index % setCount].players.push(player));
  return sets;
}

export function distributePlayers(names: string[], playersPerSet: number): PlayerSet<string>[] {
  const players = names.map((name) => name.trim()).filter(Boolean);
  return distributeItems(players, playersPerSet);
}
