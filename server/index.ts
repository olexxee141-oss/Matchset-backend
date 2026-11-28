import dotenv from 'dotenv';
import { existsSync } from 'node:fs';
import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import { Pool } from 'pg';
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { createAuthRouter } from './auth/authRouter.js';
import { createRecoveryEmailProvider } from './email/recoveryEmailProvider.js';
import { z } from 'zod';
import { distributePlayers, distributeItems } from '../src/shared/distribute.js';
import { buildCommunityLeaderboard } from '../src/shared/leaderboard.js';
import { createMemberCode } from '../src/shared/memberCode.js';
import { createRotationState, recordRotationGoal, recordRotationResult, undoRotationResult, pauseRotationTimer, resumeRotationTimer, expireRotationTimer, remainingTimeMs, type RotationOutcome, type RotationState } from '../src/shared/rotation.js';

if (process.env.NODE_ENV !== 'production') {
  dotenv.config({ path: existsSync('.env') ? '.env' : '.env.local' });
}

const app = express();
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  // Vercel may run several instances concurrently; keep each instance's pool small.
  max: 2,
  idleTimeoutMillis: 10_000,
  connectionTimeoutMillis: 5_000,
});

app.use(helmet({ crossOriginResourcePolicy: false }));
const allowedOrigins = [...new Set(['https://matchset-teal.vercel.app', 'https://matchset-y1bm.vercel.app', 'http://localhost:5173', ...(process.env.FRONTEND_ORIGIN || '').split(',').map((origin) => origin.trim()).filter(Boolean)])];
app.use(cors({ origin: allowedOrigins }));
app.use(express.json({ limit: '100kb' }));

// Cache the connectivity check per warm instance. Production schema is managed in Neon;
// never run DDL on a Vercel Function cold start.
let databaseReady: Promise<void> | undefined;
async function ensureDatabase() {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required.');
  databaseReady ??= pool.query('SELECT 1').then(() => undefined).catch((error) => {
    databaseReady = undefined;
    throw error;
  });
  await databaseReady;
}
app.use('/api', (_req, _res, next) => {
  void ensureDatabase().then(() => next()).catch(next);
});

const recoveryEmailProvider = process.env.AUTH_EMAIL_PROVIDER === 'resend'
  ? createRecoveryEmailProvider()
  : { async sendRecoveryVerificationEmail() { throw new Error('Recovery email delivery is not configured.'); } };
app.use('/api/auth', createAuthRouter(pool, recoveryEmailProvider));

const inputSchema = z.object({
  name: z.string().trim().min(1).max(80),
  players: z.array(z.string().trim().min(1).max(60)).min(2).max(500),
  playersPerSet: z.number().int().min(2).max(20),
});
const communitySchema = z.object({
  name: z.string().trim().min(2).max(60),
  creatorName: z.string().trim().min(2).max(40),
});
const memberSchema = z.object({ name: z.string().trim().min(2).max(40), ownerToken: z.string().min(20) });
const matchSchema = z.object({
  title: z.string().trim().min(2).max(80),
  memberIds: z.array(z.string().uuid()).min(4).max(500),
  playersPerTeam: z.number().int().min(2).max(20),
  createdByMemberId: z.string().uuid(),
  ownerToken: z.string().min(20),
  goalsToWin: z.number().int().min(1).max(5).default(1),
  durationMinutes: z.number().int().min(1).max(60).default(10),
});
const goalSchema = z.object({ resultToken: z.string().min(20), teamId: z.number().int().positive(), scorerId: z.string().uuid(), assisterId: z.string().uuid().nullable().optional() });
const timerSchema = z.object({ resultToken: z.string().min(20), action: z.enum(['PAUSE', 'RESUME', 'TICK']) });
const resultSchema = z.object({
  resultToken: z.string().min(20),
  winningTeamId: z.number().int().positive(),
});
const rotationResultSchema = z.object({
  resultToken: z.string().min(20),
  outcome: z.enum(['TEAM_A_WIN', 'TEAM_B_WIN', 'DRAW']),
});
const rotationUndoSchema = z.object({ resultToken: z.string().min(20) });

const adminRoleSchema = z.object({ ownerToken: z.string().min(20) });
const tournamentGroupsSchema = z.object({
  name: z.string().trim().min(2).max(80),
  ownerToken: z.string().min(20).optional(),
  groups: z.array(z.object({
    name: z.string().trim().min(1).max(30),
    teams: z.array(z.object({
      name: z.string().trim().min(1).max(40),
      memberIds: z.array(z.string().uuid()).min(2).max(20),
    })).min(1).max(20),
  })).min(2).max(16),
});
const tournamentUpdateSchema = tournamentGroupsSchema.omit({ name: true });


function hashToken(token: string) {
  return createHash('sha256').update(token).digest('hex');
}
function tokenMatches(token: string, stored: string) {
  const candidate = Buffer.from(hashToken(token));
  const expected = Buffer.from(stored);
  return candidate.length === expected.length && timingSafeEqual(candidate, expected);
}
function publicSession(row: any) {
  return {
    id: row.slug,
    name: row.name,
    players: row.players,
    playersPerSet: row.players_per_set,
    sets: row.sets,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
function normalizeName(name: string) {
  return name.trim().normalize('NFKC').toLocaleLowerCase('en').replace(/\s+/g, ' ');
}

async function communityAccess(communityId: string, req: express.Request): Promise<{ role: 'OWNER' | 'ADMIN' | 'VIEWER'; memberId?: string }> {
  const ownerToken = req.header('x-community-owner-token') || '';
  if (ownerToken) {
    const owner = await pool.query('SELECT owner_token_hash FROM communities WHERE id=$1', [communityId]);
    if (owner.rowCount && tokenMatches(ownerToken, owner.rows[0].owner_token_hash)) return { role: 'OWNER' };
  }
  const adminToken = req.header('x-community-admin-token') || '';
  if (adminToken) {
    const admin = await pool.query(
      "SELECT id FROM community_members WHERE community_id=$1 AND role='ADMIN' AND admin_token_hash=$2",
      [communityId, hashToken(adminToken)],
    );
    if (admin.rowCount) return { role: 'ADMIN', memberId: admin.rows[0].id as string };
  }
  return { role: 'VIEWER' };
}

async function requireTournamentManager(communityId: string, req: express.Request, ownerToken?: string): Promise<boolean> {
  const suppliedOwnerToken = ownerToken || req.header('x-community-owner-token') || '';
  if (suppliedOwnerToken) {
    const owner = await pool.query('SELECT owner_token_hash FROM communities WHERE id=$1', [communityId]);
    if (owner.rowCount && tokenMatches(suppliedOwnerToken, owner.rows[0].owner_token_hash)) return true;
  }
  const adminToken = req.header('x-community-admin-token') || '';
  if (!adminToken) return false;
  const admin = await pool.query(
    "SELECT id FROM community_members WHERE community_id=$1 AND role='ADMIN' AND admin_token_hash=$2",
    [communityId, hashToken(adminToken)],
  );
  return Boolean(admin.rowCount);
}

async function persistTournamentGroups(
  client: import('pg').PoolClient,
  tournamentId: string,
  communityId: string,
  groups: z.infer<typeof tournamentGroupsSchema>['groups'],
): Promise<void> {
  const allMemberIds = groups.flatMap((group) => group.teams.flatMap((team) => team.memberIds));
  if (new Set(allMemberIds).size !== allMemberIds.length) throw new Error('A player can only belong to one team in a tournament.');
  const members = await client.query(
    'SELECT id, display_name, member_code FROM community_members WHERE community_id=$1 AND id = ANY($2::uuid[])',
    [communityId, allMemberIds],
  );
  if (members.rowCount !== allMemberIds.length) throw new Error('Every tournament player must belong to this community.');
  const byId = new Map<string, { name: string; memberCode: string }>(members.rows.map((member: { id: string; display_name: string; member_code: string }) => [member.id, { name: member.display_name, memberCode: member.member_code }]));
  await client.query('DELETE FROM tournament_groups WHERE tournament_id=$1', [tournamentId]);
  for (const [groupIndex, group] of groups.entries()) {
    const groupId = randomUUID();
    await client.query(
      'INSERT INTO tournament_groups (id, tournament_id, name, sort_order) VALUES ($1,$2,$3,$4)',
      [groupId, tournamentId, group.name, groupIndex],
    );
    for (const [teamIndex, team] of group.teams.entries()) {
      const snapshot = team.memberIds.map((id) => ({ id, name: byId.get(id)?.name, memberCode: byId.get(id)?.memberCode }));
      await client.query(
        'INSERT INTO tournament_teams (id, tournament_id, group_id, name, members, sort_order) VALUES ($1,$2,$3,$4,$5,$6)',
        [randomUUID(), tournamentId, groupId, team.name, JSON.stringify(snapshot), teamIndex],
      );
    }
  }
}

async function readTournaments(communityId: string): Promise<Array<{ id: string; name: string; createdAt: string; groups: Array<{ id: string; name: string; teams: Array<{ id: string; name: string; members: Array<{ id: string; name: string }> }> }> }>> {
  const result = await pool.query(
    `SELECT t.id AS tournament_id, t.name AS tournament_name, t.created_at,
            g.id AS group_id, g.name AS group_name, g.sort_order AS group_order,
            tm.id AS team_id, tm.name AS team_name, tm.members, tm.sort_order AS team_order
       FROM tournaments t
       LEFT JOIN tournament_groups g ON g.tournament_id=t.id
       LEFT JOIN tournament_teams tm ON tm.group_id=g.id
      WHERE t.community_id=$1
      ORDER BY t.created_at DESC, g.sort_order, tm.sort_order`,
    [communityId],
  );
  const tournaments = new Map<string, { id: string; name: string; createdAt: string; groups: Array<{ id: string; name: string; teams: Array<{ id: string; name: string; members: Array<{ id: string; name: string }> }> }> }>();
  for (const row of result.rows as Array<any>) {
    if (!tournaments.has(row.tournament_id)) tournaments.set(row.tournament_id, {
      id: row.tournament_id, name: row.tournament_name, createdAt: row.created_at, groups: [],
    });
    const tournament = tournaments.get(row.tournament_id)!;
    if (row.group_id) {
      let group = tournament.groups.find((item) => item.id === row.group_id);
      if (!group) {
        group = { id: row.group_id, name: row.group_name, teams: [] };
        tournament.groups.push(group);
      }
      if (row.team_id) group.teams.push({ id: row.team_id, name: row.team_name, members: row.members });
    }
  }
  return [...tournaments.values()];
}

app.get('/api/health', async (_req, res, next) => {
  try {
    await pool.query('SELECT 1');
    res.json({ status: 'ok', database: 'connected' });
  } catch (error) { next(error); }
});

app.post('/api/sessions', async (req, res, next) => {
  try {
    const input = inputSchema.parse(req.body);
    const players = input.players.map((name) => name.trim());
    if (players.some((name) => !name)) return res.status(400).json({ error: 'Player names cannot be empty.' });
    const slug = randomBytes(9).toString('base64url');
    const editToken = randomBytes(32).toString('base64url');
    const sets = distributePlayers(players, input.playersPerSet);
    const result = await pool.query(
      'INSERT INTO match_sessions (id, slug, edit_token_hash, name, players, players_per_set, sets) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *',
      [randomUUID(), slug, hashToken(editToken), input.name, JSON.stringify(players), input.playersPerSet, JSON.stringify(sets)],
    );
    res.status(201).json({ session: publicSession(result.rows[0]), editToken });
  } catch (error) { next(error); }
});

app.get('/api/sessions/:slug', async (req, res, next) => {
  try {
    const result = await pool.query('SELECT * FROM match_sessions WHERE slug = $1', [req.params.slug]);
    if (!result.rowCount) return res.status(404).json({ error: 'This set could not be found.' });
    res.json({ session: publicSession(result.rows[0]) });
  } catch (error) { next(error); }
});

app.put('/api/sessions/:slug', async (req, res, next) => {
  try {
    const editSchema = inputSchema.extend({ editToken: z.string().min(20) });
    const input = editSchema.parse(req.body);
    const found = await pool.query('SELECT * FROM match_sessions WHERE slug = $1', [req.params.slug]);
    if (!found.rowCount) return res.status(404).json({ error: 'This set could not be found.' });
    if (!tokenMatches(input.editToken, found.rows[0].edit_token_hash)) return res.status(403).json({ error: 'Only the creator can edit this set.' });
    const names = input.players.map((name) => name.trim());
    if (names.some((name) => !name)) return res.status(400).json({ error: 'Player names cannot be empty.' });
    const sets = distributePlayers(names, input.playersPerSet);
    const updated = await pool.query(
      'UPDATE match_sessions SET name=$1, players=$2, players_per_set=$3, sets=$4, updated_at=NOW() WHERE slug=$5 RETURNING *',
      [input.name, JSON.stringify(names), input.playersPerSet, JSON.stringify(sets), req.params.slug],
    );
    res.json({ session: publicSession(updated.rows[0]) });
  } catch (error) { next(error); }
});

// Community creation returns a one-time owner token. The raw token is never stored in Postgres.
app.post('/api/communities', async (req, res, next) => {
  try {
    const input = communitySchema.parse(req.body);
    const communityId = randomUUID();
    const memberId = randomUUID();
    const slug = randomBytes(9).toString('base64url');
    const ownerToken = randomBytes(32).toString('base64url');
    const memberName = input.creatorName.trim();
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const community = await client.query(
        'INSERT INTO communities (id, slug, name, owner_token_hash) VALUES ($1,$2,$3,$4) RETURNING id, slug, name, created_at',
        [communityId, slug, input.name, hashToken(ownerToken)],
      );
      const memberCode = createMemberCode(memberId);
      const member = await client.query(
        'INSERT INTO community_members (id, community_id, display_name, normalized_name, member_code) VALUES ($1,$2,$3,$4,$5) RETURNING id, display_name, member_code',
        [memberId, communityId, memberName, normalizeName(memberName), memberCode],
      );
      await client.query('COMMIT');
      res.status(201).json({ community: community.rows[0], member: member.rows[0], ownerToken });
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally { client.release(); }
  } catch (error) { next(error); }
});

app.get('/api/communities/:slug', async (req, res, next) => {
  try {
    const found = await pool.query('SELECT id, slug, name, created_at FROM communities WHERE slug=$1', [req.params.slug]);
    if (!found.rowCount) return res.status(404).json({ error: 'Community not found.' });
    const community = found.rows[0];
    const [membersResult, matchesResult, leaderboardResult, tournaments] = await Promise.all([
      pool.query("SELECT id, display_name AS name, member_code AS \"memberCode\", joined_at, role FROM community_members WHERE community_id=$1 ORDER BY display_name, member_code", [community.id]),
      pool.query('SELECT id, title, teams, winning_team_id, rotation_state, created_at, completed_at FROM community_matches WHERE community_id=$1 ORDER BY created_at DESC LIMIT 100', [community.id]),
      pool.query('SELECT teams, winning_team_id, rotation_state FROM community_matches WHERE community_id=$1 AND (completed_at IS NOT NULL OR rotation_state IS NOT NULL)', [community.id]),
      readTournaments(community.id),
    ]);
    const matches = matchesResult.rows.map((row) => ({
      id: row.id, title: row.title, teams: row.teams, winningTeamId: row.winning_team_id, rotationState: row.rotation_state,
      createdAt: row.created_at, completedAt: row.completed_at,
    }));
    res.json({
      community: { slug: community.slug, name: community.name, createdAt: community.created_at },
      members: membersResult.rows,
      matches,
      leaderboard: buildCommunityLeaderboard(leaderboardResult.rows),
      tournaments,
      access: await communityAccess(community.id, req),
    });
  } catch (error) { next(error); }
});

app.post('/api/communities/:slug/members', async (req, res, next) => {
  try {
    const input = memberSchema.parse(req.body);
    const community = await pool.query('SELECT id, owner_token_hash FROM communities WHERE slug=$1', [req.params.slug]);
    if (!community.rowCount) return res.status(404).json({ error: 'Community not found.' });
    if (!tokenMatches(input.ownerToken, community.rows[0].owner_token_hash)) return res.status(403).json({ error: 'Only the community creator can manage the roster.' });
    const name = input.name.trim();
    const memberId = randomUUID();
    const memberCode = createMemberCode(memberId);
    const result = await pool.query(
      'INSERT INTO community_members (id, community_id, display_name, normalized_name, member_code) VALUES ($1,$2,$3,$4,$5) RETURNING id, display_name AS name, member_code AS "memberCode", joined_at',
      [memberId, community.rows[0].id, name, normalizeName(name), memberCode],
    );
    res.status(201).json({ member: result.rows[0] });
  } catch (error) { next(error); }
});

app.post('/api/communities/:slug/members/:memberId/admin', async (req, res, next) => {
  const client = await pool.connect();
  try {
    const input = adminRoleSchema.parse(req.body);
    const community = await pool.query('SELECT id, owner_token_hash FROM communities WHERE slug=$1', [req.params.slug]);
    if (!community.rowCount) return res.status(404).json({ error: 'Community not found.' });
    if (!tokenMatches(input.ownerToken, community.rows[0].owner_token_hash)) return res.status(403).json({ error: 'Only the community owner can appoint admins.' });
    const member = await pool.query('SELECT id, role FROM community_members WHERE id=$1 AND community_id=$2', [req.params.memberId, community.rows[0].id]);
    if (!member.rowCount) return res.status(404).json({ error: 'Community member not found.' });
    const adminToken = randomBytes(32).toString('base64url');
    await client.query('BEGIN');
    await client.query("UPDATE community_members SET role='ADMIN', admin_token_hash=$1 WHERE id=$2", [hashToken(adminToken), req.params.memberId]);
    await client.query(
      "INSERT INTO community_role_audit (id, community_id, member_id, previous_role, new_role, changed_by, created_at) VALUES ($1,$2,$3,$4,'ADMIN','OWNER',NOW())",
      [randomUUID(), community.rows[0].id, req.params.memberId, member.rows[0].role],
    );
    await client.query('COMMIT');
    res.json({ role: 'ADMIN', adminToken });
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    next(error);
  } finally { client.release(); }
});

app.delete('/api/communities/:slug/members/:memberId/admin', async (req, res, next) => {
  const client = await pool.connect();
  try {
    const input = adminRoleSchema.parse(req.body);
    const community = await pool.query('SELECT id, owner_token_hash FROM communities WHERE slug=$1', [req.params.slug]);
    if (!community.rowCount) return res.status(404).json({ error: 'Community not found.' });
    if (!tokenMatches(input.ownerToken, community.rows[0].owner_token_hash)) return res.status(403).json({ error: 'Only the community owner can remove admins.' });
    const member = await pool.query('SELECT id, role FROM community_members WHERE id=$1 AND community_id=$2', [req.params.memberId, community.rows[0].id]);
    if (!member.rowCount) return res.status(404).json({ error: 'Community member not found.' });
    if (member.rows[0].role !== 'ADMIN') return res.status(409).json({ error: 'This member is not an admin.' });
    await client.query('BEGIN');
    await client.query("UPDATE community_members SET role='MEMBER', admin_token_hash=NULL WHERE id=$1", [req.params.memberId]);
    await client.query(
      "INSERT INTO community_role_audit (id, community_id, member_id, previous_role, new_role, changed_by, created_at) VALUES ($1,$2,$3,'ADMIN','MEMBER','OWNER',NOW())",
      [randomUUID(), community.rows[0].id, req.params.memberId],
    );
    await client.query('COMMIT');
    res.json({ role: 'MEMBER' });
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    next(error);
  } finally { client.release(); }
});

app.post('/api/communities/:slug/tournaments', async (req, res, next) => {
  const client = await pool.connect();
  try {
    const input = tournamentGroupsSchema.parse(req.body);
    const community = await pool.query('SELECT id FROM communities WHERE slug=$1', [req.params.slug]);
    if (!community.rowCount) return res.status(404).json({ error: 'Community not found.' });
    if (!(await requireTournamentManager(community.rows[0].id, req, input.ownerToken))) return res.status(403).json({ error: 'Only the owner or an appointed admin can manage tournament groups.' });
    await client.query('BEGIN');
    const tournamentId = randomUUID();
    await client.query(
      'INSERT INTO tournaments (id, community_id, name) VALUES ($1,$2,$3)',
      [tournamentId, community.rows[0].id, input.name],
    );
    await persistTournamentGroups(client, tournamentId, community.rows[0].id, input.groups);
    await client.query('COMMIT');
    res.status(201).json({ tournaments: await readTournaments(community.rows[0].id) });
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    if (error instanceof Error && (error.message.includes('player') || error.message.includes('belong to'))) return res.status(400).json({ error: error.message });
    next(error);
  } finally { client.release(); }
});

app.put('/api/communities/:slug/tournaments/:tournamentId/groups', async (req, res, next) => {
  const client = await pool.connect();
  try {
    const input = tournamentUpdateSchema.parse(req.body);
    const community = await pool.query('SELECT id FROM communities WHERE slug=$1', [req.params.slug]);
    if (!community.rowCount) return res.status(404).json({ error: 'Community not found.' });
    if (!(await requireTournamentManager(community.rows[0].id, req, input.ownerToken))) return res.status(403).json({ error: 'Only the owner or an appointed admin can manage tournament groups.' });
    const tournament = await pool.query('SELECT id FROM tournaments WHERE id=$1 AND community_id=$2', [req.params.tournamentId, community.rows[0].id]);
    if (!tournament.rowCount) return res.status(404).json({ error: 'Tournament not found.' });
    await client.query('BEGIN');
    await persistTournamentGroups(client, req.params.tournamentId, community.rows[0].id, input.groups);
    await client.query('COMMIT');
    res.json({ tournaments: await readTournaments(community.rows[0].id) });
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    if (error instanceof Error && (error.message.includes('player') || error.message.includes('belong to'))) return res.status(400).json({ error: error.message });
    next(error);
  } finally { client.release(); }
});

app.post('/api/communities/:slug/matches', async (req, res, next) => {
  try {
    const input = matchSchema.parse(req.body);
    const community = await pool.query('SELECT id, owner_token_hash FROM communities WHERE slug=$1', [req.params.slug]);
    if (!community.rowCount) return res.status(404).json({ error: 'Community not found.' });
    if (!tokenMatches(input.ownerToken, community.rows[0].owner_token_hash)) return res.status(403).json({ error: 'Only the community organiser can create matches.' });
    const membersResult = await pool.query(
      'SELECT id, display_name, member_code FROM community_members WHERE community_id=$1 AND id = ANY($2::uuid[])',
      [community.rows[0].id, input.memberIds],
    );
    if (membersResult.rowCount !== input.memberIds.length) return res.status(400).json({ error: 'Every selected player must belong to this community.' });
    if (!membersResult.rows.some((member: any) => member.id === input.createdByMemberId)) return res.status(400).json({ error: 'The match organiser must be a member of this community.' });
    if (Math.ceil(membersResult.rowCount / input.playersPerTeam) < 2) return res.status(400).json({ error: 'Add enough players to create at least two teams.' });
    const distributed = distributeItems(membersResult.rows as Array<{ id: string; display_name: string }>, input.playersPerTeam);
    const teams = distributed.map((team) => ({
      id: team.id,
      players: team.players.map((member) => ({ id: member.id, name: member.display_name })),
    }));
    const matchId = randomUUID();
    const resultToken = randomBytes(32).toString('base64url');
    const result = await pool.query(
      'INSERT INTO community_matches (id, community_id, title, teams, created_by_member_id, result_token_hash, rotation_state) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id, title, teams, winning_team_id, rotation_state, created_at, completed_at',
      [matchId, community.rows[0].id, input.title, JSON.stringify(teams), input.createdByMemberId, hashToken(resultToken), JSON.stringify(createRotationState(teams.map((team) => team.id), { goalsToWin: input.goalsToWin, durationSeconds: input.durationMinutes * 60 }))],
    );
    res.status(201).json({ match: result.rows[0], resultToken });
  } catch (error) { next(error); }
});

app.post('/api/communities/:slug/matches/:matchId/result', async (req, res, next) => {
  try {
    const input = resultSchema.parse(req.body);
    const community = await pool.query('SELECT id FROM communities WHERE slug=$1', [req.params.slug]);
    if (!community.rowCount) return res.status(404).json({ error: 'Community not found.' });
    const found = await pool.query('SELECT * FROM community_matches WHERE id=$1 AND community_id=$2', [req.params.matchId, community.rows[0].id]);
    if (!found.rowCount) return res.status(404).json({ error: 'Match not found.' });
    const match = found.rows[0];
    if (!tokenMatches(input.resultToken, match.result_token_hash)) return res.status(403).json({ error: 'Only the match organiser can record its result.' });
    if (match.rotation_state) return res.status(409).json({ error: 'Use the rotation result action for this match.' });
    const teams = match.teams as Array<{ id: number }>;
    if (!teams.some((team) => team.id === input.winningTeamId)) return res.status(400).json({ error: 'Select a valid winning team.' });
    if (match.winning_team_id !== null) return res.status(409).json({ error: 'This match result has already been recorded.' });
    const updated = await pool.query(
      'UPDATE community_matches SET winning_team_id=$1, completed_at=NOW() WHERE id=$2 AND winning_team_id IS NULL RETURNING id, winning_team_id, completed_at',
      [input.winningTeamId, match.id],
    );
    if (!updated.rowCount) return res.status(409).json({ error: 'This match result has already been recorded.' });
    res.json({ match: updated.rows[0] });
  } catch (error) { next(error); }
});

app.post('/api/communities/:slug/matches/:matchId/rotation/result', async (req, res, next) => {
  const client = await pool.connect();
  try {
    const input = rotationResultSchema.parse(req.body);
    const community = await client.query('SELECT id FROM communities WHERE slug=$1', [req.params.slug]);
    if (!community.rowCount) return res.status(404).json({ error: 'Community not found.' });
    await client.query('BEGIN');
    const found = await client.query(
      'SELECT * FROM community_matches WHERE id=$1 AND community_id=$2 FOR UPDATE',
      [req.params.matchId, community.rows[0].id],
    );
    if (!found.rowCount) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Match not found.' }); }
    const match = found.rows[0];
    if (!tokenMatches(input.resultToken, match.result_token_hash)) { await client.query('ROLLBACK'); return res.status(403).json({ error: 'Only the match organiser can record its result.' }); }
    if (!match.rotation_state) { await client.query('ROLLBACK'); return res.status(409).json({ error: 'This match does not have a rotation session.' }); }
    if (input.outcome !== 'DRAW') { await client.query('ROLLBACK'); return res.status(409).json({ error: 'Wins are determined by the goal target or timer. Only an organiser-declared draw is available here.' }); }
    const nextState = recordRotationResult(match.rotation_state as RotationState, input.outcome as RotationOutcome);
    const updated = await client.query(
      'UPDATE community_matches SET rotation_state=$1 WHERE id=$2 RETURNING id, title, teams, winning_team_id, rotation_state, created_at, completed_at',
      [JSON.stringify(nextState), match.id],
    );
    await client.query('COMMIT');
    res.json({ match: updated.rows[0] });
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    if (error instanceof Error && (error.message.includes('not active') || error.message.includes('Two active'))) return res.status(409).json({ error: error.message });
    next(error);
  } finally { client.release(); }
});

app.post('/api/communities/:slug/matches/:matchId/rotation/goal', async (req, res, next) => {
  const client = await pool.connect();
  try {
    const input = goalSchema.parse(req.body);
    const community = await client.query('SELECT id FROM communities WHERE slug=$1', [req.params.slug]);
    if (!community.rowCount) return res.status(404).json({ error: 'Community not found.' });
    await client.query('BEGIN');
    const found = await client.query('SELECT * FROM community_matches WHERE id=$1 AND community_id=$2 FOR UPDATE', [req.params.matchId, community.rows[0].id]);
    if (!found.rowCount) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Match not found.' }); }
    const match = found.rows[0];
    if (!tokenMatches(input.resultToken, match.result_token_hash)) { await client.query('ROLLBACK'); return res.status(403).json({ error: 'Only the match organiser can record goals.' }); }
    if (!match.rotation_state) { await client.query('ROLLBACK'); return res.status(409).json({ error: 'This match does not have a rotation session.' }); }
    const state = match.rotation_state as RotationState;
    if (remainingTimeMs(state) <= 0) {
      const expired = expireRotationTimer(state);
      const updated = await client.query('UPDATE community_matches SET rotation_state=$1 WHERE id=$2 RETURNING id,title,teams,winning_team_id,rotation_state,created_at,completed_at', [JSON.stringify(expired), match.id]);
      await client.query('COMMIT');
      return res.json({ match: updated.rows[0], timerExpired: true });
    }
    const team = (match.teams as Array<{ id: number; players: Array<{ id: string; name: string }> }>).find((item) => item.id === input.teamId);
    if (!team || !state.activeTeamIds.includes(input.teamId)) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'Goals can only be assigned to one of the two active teams.' }); }
    const scorer = team.players.find((player) => player.id === input.scorerId);
    if (!scorer) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'The scorer must belong to the scoring team.' }); }
    const assister = input.assisterId ? team.players.find((player) => player.id === input.assisterId) : undefined;
    if (input.assisterId && !assister) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'The assister must belong to the scoring team.' }); }
    if (input.assisterId === input.scorerId) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'A player cannot assist their own goal.' }); }
    const nextState = recordRotationGoal(state, {
      teamId: input.teamId, scorerId: scorer.id, scorerName: scorer.name,
      assisterId: assister?.id ?? null, assisterName: assister?.name ?? null,
    });
    const updated = await client.query('UPDATE community_matches SET rotation_state=$1 WHERE id=$2 RETURNING id,title,teams,winning_team_id,rotation_state,created_at,completed_at', [JSON.stringify(nextState), match.id]);
    await client.query('COMMIT');
    res.json({ match: updated.rows[0] });
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    if (error instanceof Error && (error.message.includes('not active') || error.message.includes('active teams') || error.message.includes('assist'))) return res.status(409).json({ error: error.message });
    next(error);
  } finally { client.release(); }
});

app.post('/api/communities/:slug/matches/:matchId/rotation/timer', async (req, res, next) => {
  const client = await pool.connect();
  try {
    const input = timerSchema.parse(req.body);
    const community = await client.query('SELECT id FROM communities WHERE slug=$1', [req.params.slug]);
    if (!community.rowCount) return res.status(404).json({ error: 'Community not found.' });
    await client.query('BEGIN');
    const found = await client.query('SELECT * FROM community_matches WHERE id=$1 AND community_id=$2 FOR UPDATE', [req.params.matchId, community.rows[0].id]);
    if (!found.rowCount) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Match not found.' }); }
    const match = found.rows[0];
    if (!tokenMatches(input.resultToken, match.result_token_hash)) { await client.query('ROLLBACK'); return res.status(403).json({ error: 'Only the match organiser can control its timer.' }); }
    if (!match.rotation_state) { await client.query('ROLLBACK'); return res.status(409).json({ error: 'This match does not have a rotation session.' }); }
    let nextState = match.rotation_state as RotationState;
    if (input.action === 'PAUSE') nextState = pauseRotationTimer(nextState);
    if (input.action === 'RESUME') nextState = resumeRotationTimer(nextState);
    if (input.action === 'TICK') nextState = expireRotationTimer(nextState);
    const updated = await client.query('UPDATE community_matches SET rotation_state=$1 WHERE id=$2 RETURNING id,title,teams,winning_team_id,rotation_state,created_at,completed_at', [JSON.stringify(nextState), match.id]);
    await client.query('COMMIT');
    res.json({ match: updated.rows[0] });
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    if (error instanceof Error && error.message.includes('not active')) return res.status(409).json({ error: error.message });
    next(error);
  } finally { client.release(); }
});

app.post('/api/communities/:slug/matches/:matchId/rotation/undo', async (req, res, next) => {
  const client = await pool.connect();
  try {
    const input = rotationUndoSchema.parse(req.body);
    const community = await client.query('SELECT id FROM communities WHERE slug=$1', [req.params.slug]);
    if (!community.rowCount) return res.status(404).json({ error: 'Community not found.' });
    await client.query('BEGIN');
    const found = await client.query(
      'SELECT * FROM community_matches WHERE id=$1 AND community_id=$2 FOR UPDATE',
      [req.params.matchId, community.rows[0].id],
    );
    if (!found.rowCount) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Match not found.' }); }
    const match = found.rows[0];
    if (!tokenMatches(input.resultToken, match.result_token_hash)) { await client.query('ROLLBACK'); return res.status(403).json({ error: 'Only the match organiser can undo results.' }); }
    if (!match.rotation_state) { await client.query('ROLLBACK'); return res.status(409).json({ error: 'This match does not have a rotation session.' }); }
    const nextState = undoRotationResult(match.rotation_state as RotationState);
    const updated = await client.query(
      'UPDATE community_matches SET rotation_state=$1 WHERE id=$2 RETURNING id, title, teams, winning_team_id, rotation_state, created_at, completed_at',
      [JSON.stringify(nextState), match.id],
    );
    await client.query('COMMIT');
    res.json({ match: updated.rows[0] });
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    if (error instanceof Error && error.message.includes('no result')) return res.status(409).json({ error: error.message });
    next(error);
  } finally { client.release(); }
});

app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  if (error instanceof z.ZodError) return res.status(400).json({ error: error.issues[0]?.message || 'Invalid input.' });
  if (typeof error === 'object' && error !== null && 'code' in error && error.code === '23505') return res.status(409).json({ error: 'A conflicting record already exists.' });
  console.error(error);
  return res.status(500).json({ error: 'Something went wrong. Please try again.' });
});

app.use('/api', (_req, res) => res.status(404).json({ error: 'API route not found.' }));

export default app;
