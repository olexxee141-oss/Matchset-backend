import { randomBytes, randomUUID, createHash, scryptSync, timingSafeEqual } from 'node:crypto';
import { Router, type Request, type Response, type NextFunction } from 'express';
import type { Pool, PoolClient } from 'pg';
import { generateAuthenticationOptions, generateRegistrationOptions, verifyAuthenticationResponse, verifyRegistrationResponse } from '@simplewebauthn/server';
import { z } from 'zod';
import type { RecoveryEmailProvider } from '../email/recoveryEmailProvider.js';

const SESSION_COOKIE = 'matchset_session';
const FLOW_COOKIE = 'matchset_auth_flow';
const SESSION_TTL = 60 * 60 * 24 * 30;
const FLOW_TTL = 300;
const RECOVERY_EMAIL_TTL = 15;
const MAX_RECOVERY_ATTEMPTS = 5;

type AuthConfig = { rpName: string; rpId: string; origins: string[]; appBaseUrl: string; secureCookies: boolean };
type Purpose = 'PASSKEY_REGISTRATION' | 'PASSKEY_AUTHENTICATION' | 'RECOVERY_EMAIL_VERIFICATION' | 'RECOVERY_PASSKEY_REGISTRATION';

const recoveryStartSchema = z.object({ recoveryCode: z.string().min(30).max(180), email: z.string().trim().email().max(254) });
const responseSchema = z.object({ response: z.record(z.unknown()) });
const recoveryVerifySchema = z.object({ token: z.string().min(32).max(200) });

function sha(value: string): string { return createHash('sha256').update(value).digest('hex'); }
function equalHex(a: string, b: string): boolean {
  if (!/^(?:[a-f0-9]{2})+$/i.test(a) || !/^(?:[a-f0-9]{2})+$/i.test(b) || a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
}
function token(bytes = 32): string { return randomBytes(bytes).toString('base64url'); }
function codeFor(userId: string): string { return 'MSR-' + userId + '.' + token(32); }
function parseCode(code: string): { userId: string; secret: string } | null {
  const match = /^MSR-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.([A-Za-z0-9_-]{40,60})$/i.exec(code);
  return match ? { userId: match[1], secret: match[2] } : null;
}
function recoveryHash(secret: string, salt: string): string { return scryptSync(secret, salt, 64).toString('hex'); }
function cookie(req: Request, name: string): string | null {
  for (const item of (req.headers.cookie || '').split(';')) {
    const [key, ...value] = item.trim().split('=');
    if (key === name) { try { return decodeURIComponent(value.join('=')); } catch { return null; } }
  }
  return null;
}
function setCookie(res: Response, name: string, value: string, maxAge: number, secure: boolean): void {
  const parts = [name + '=' + encodeURIComponent(value), 'Path=/api/auth', 'HttpOnly', 'SameSite=Lax', 'Max-Age=' + maxAge];
  if (secure) parts.push('Secure');
  res.append('Set-Cookie', parts.join('; '));
}
function clearCookie(res: Response, name: string, secure: boolean): void { setCookie(res, name, '', 0, secure); }

function authConfig(env: NodeJS.ProcessEnv): AuthConfig {
  const configuredFrontend = (env.WEBAUTHN_ORIGIN || env.FRONTEND_ORIGIN || '').split(',').map((v) => v.trim()).filter(Boolean);
  const base = new URL(env.APP_BASE_URL || configuredFrontend[0] || 'http://localhost:5173');
  const origins = configuredFrontend.length ? configuredFrontend : [base.origin];
  const rpId = env.WEBAUTHN_RP_ID || new URL(origins[0]).hostname;
  if (!origins.length || origins.some((v) => new URL(v).origin !== v)) throw new Error('WEBAUTHN_ORIGIN must contain exact origins.');
  if (env.NODE_ENV === 'production' && (base.protocol !== 'https:' || origins.some((v) => new URL(v).protocol !== 'https:') || !origins.some((v) => new URL(v).hostname === rpId || new URL(v).hostname.endsWith('.' + rpId)))) {
    throw new Error('Production WebAuthn requires HTTPS origins and an RP ID matching the frontend domain.');
  }
  return { rpName: env.WEBAUTHN_RP_NAME || 'MatchSet', rpId, origins, appBaseUrl: base.origin, secureCookies: env.NODE_ENV === 'production' };
}

async function insertChallenge(db: Pool | PoolClient, userId: string | null, purpose: Purpose, challenge: string, flowToken: string, ttl = FLOW_TTL): Promise<void> {
  await db.query(
    "INSERT INTO auth_challenges (id,user_id,challenge_hash,flow_token_hash,purpose,expires_at) VALUES ($1,$2,$3,$4,$5,NOW()+($6*INTERVAL '1 second'))",
    [randomUUID(), userId, sha(challenge), sha(flowToken), purpose, ttl],
  );
}
async function newSession(db: Pool | PoolClient, userId: string): Promise<{ token: string; csrfToken: string }> {
  const sessionToken = token(48);
  const csrfToken = token(32);
  await db.query(
    "INSERT INTO auth_sessions (id,user_id,token_hash,csrf_token_hash,expires_at) VALUES ($1,$2,$3,$4,NOW()+($5*INTERVAL '1 second'))",
    [randomUUID(), userId, sha(sessionToken), sha(csrfToken), SESSION_TTL],
  );
  return { token: sessionToken, csrfToken };
}
async function findSession(pool: Pool, req: Request): Promise<{ id: string; userId: string; csrfHash: string } | null> {
  const value = cookie(req, SESSION_COOKIE);
  if (!value) return null;
  const found = await pool.query("SELECT id,user_id,csrf_token_hash FROM auth_sessions WHERE token_hash=$1 AND revoked_at IS NULL AND expires_at>NOW()", [sha(value)]);
  return found.rowCount ? { id: found.rows[0].id, userId: found.rows[0].user_id, csrfHash: found.rows[0].csrf_token_hash } : null;
}
async function saveCredential(client: PoolClient, userId: string, response: Record<string, unknown>, expectedHash: string, config: AuthConfig): Promise<void> {
  const result = await verifyRegistrationResponse({
    response: response as never,
    expectedChallenge: async (challenge) => equalHex(sha(challenge), expectedHash),
    expectedOrigin: config.origins,
    expectedRPID: config.rpId,
    requireUserVerification: true,
    supportedAlgorithmIDs: [-7, -257],
  });
  if (!result.verified || !result.registrationInfo) throw new Error('Passkey verification failed.');
  const info = result.registrationInfo;
  const credential = info.credential;
  await client.query(
    "INSERT INTO user_passkey_credentials (credential_id,user_id,public_key,signature_counter,transports,device_type,backed_up,aaguid) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)",
    [credential.id, userId, Buffer.from(credential.publicKey), credential.counter, credential.transports ?? [], info.credentialDeviceType, info.credentialBackedUp, info.aaguid ?? null],
  );
}
async function makeRegistrationOptions(pool: Pool, userId: string, config: AuthConfig): Promise<Awaited<ReturnType<typeof generateRegistrationOptions>>> {
  const existing = await pool.query("SELECT credential_id,transports FROM user_passkey_credentials WHERE user_id=$1 AND revoked_at IS NULL", [userId]);
  return generateRegistrationOptions({
    rpName: config.rpName,
    rpID: config.rpId,
    userID: Buffer.from(userId.replace(/-/g, ''), 'hex'),
    userName: 'matchset-' + userId,
    userDisplayName: 'MatchSet member',
    attestationType: 'none',
    excludeCredentials: existing.rows.map((r) => ({ id: r.credential_id, transports: r.transports })),
    authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
    supportedAlgorithmIDs: [-7, -257],
  });
}
async function saveNewRecoveryCode(client: PoolClient, userId: string): Promise<string> {
  const value = codeFor(userId);
  const parts = parseCode(value)!;
  const salt = randomBytes(16).toString('hex');
  await client.query("INSERT INTO user_recovery_codes (id,user_id,code_salt,code_hash) VALUES ($1,$2,$3,$4)", [randomUUID(), userId, salt, recoveryHash(parts.secret, salt)]);
  return value;
}

export function createAuthRouter(pool: Pool, emailProvider: RecoveryEmailProvider, env: NodeJS.ProcessEnv = process.env): Router {
  const router = Router();
  const config = authConfig(env);

  router.use((req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    if (!['GET', 'HEAD'].includes(req.method)) {
      const origin = req.get('origin');
      if (!origin || !config.origins.includes(origin)) return res.status(403).json({ error: 'Request origin is not allowed.' });
    }
    next();
  });

  const requireSession = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const session = await findSession(pool, req);
      if (!session) return res.status(401).json({ error: 'Sign in with a passkey to continue.' });
      res.locals.authSession = session;
      next();
    } catch (error) { next(error); }
  };
  const requireCsrf = (req: Request, res: Response, next: NextFunction) => {
    const session = res.locals.authSession as { csrfHash: string } | undefined;
    const supplied = req.get('x-csrf-token') || '';
    if (!session || !supplied || !equalHex(sha(supplied), session.csrfHash)) return res.status(403).json({ error: 'Session verification failed. Refresh and try again.' });
    next();
  };

  router.post('/register/options', async (_req, res, next) => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const userId = randomUUID();
      await client.query("INSERT INTO users (id,status) VALUES ($1,'PENDING')", [userId]);
      const options = await makeRegistrationOptions(pool, userId, config);
      const flow = token();
      await insertChallenge(client, userId, 'PASSKEY_REGISTRATION', String(options.challenge), flow);
      await client.query('COMMIT');
      setCookie(res, FLOW_COOKIE, flow, FLOW_TTL, config.secureCookies);
      res.json({ options });
    } catch (error) { await client.query('ROLLBACK').catch(() => undefined); next(error); }
    finally { client.release(); }
  });

  router.post('/register/verify', async (req, res) => {
    const input = responseSchema.safeParse(req.body);
    const flow = cookie(req, FLOW_COOKIE);
    if (!input.success || !flow) return res.status(400).json({ error: 'Registration expired. Start again.' });
    const attempt = await pool.query(
      "UPDATE auth_challenges SET attempt_count=attempt_count+1 WHERE flow_token_hash=$1 AND purpose='PASSKEY_REGISTRATION' AND consumed_at IS NULL AND expires_at>NOW() AND attempt_count<5 RETURNING id",
      [sha(flow)],
    );
    if (!attempt.rowCount) return res.status(400).json({ error: 'Registration expired or too many attempts. Start again.' });
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const challenge = await client.query(
        "SELECT id,user_id,challenge_hash FROM auth_challenges WHERE id=$1 AND consumed_at IS NULL AND expires_at>NOW() FOR UPDATE",
        [attempt.rows[0].id],
      );
      if (!challenge.rowCount) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'Registration expired. Start again.' }); }
      const userId = challenge.rows[0].user_id as string;
      await saveCredential(client, userId, input.data.response, challenge.rows[0].challenge_hash, config);
      await client.query("UPDATE auth_challenges SET consumed_at=NOW() WHERE id=$1", [challenge.rows[0].id]);
      await client.query("UPDATE users SET status='ACTIVE',updated_at=NOW() WHERE id=$1", [userId]);
      const recoveryCode = await saveNewRecoveryCode(client, userId);
      const session = await newSession(client, userId);
      await client.query('COMMIT');
      clearCookie(res, FLOW_COOKIE, config.secureCookies);
      setCookie(res, SESSION_COOKIE, session.token, SESSION_TTL, config.secureCookies);
      res.status(201).json({ authenticated: true, recoveryCode, csrfToken: session.csrfToken });
    } catch {
      await client.query('ROLLBACK').catch(() => undefined);
      res.status(400).json({ error: 'Passkey registration failed. Start again and retry.' });
    } finally { client.release(); }
  });

  router.post('/login/options', async (_req, res, next) => {
    try {
      const options = await generateAuthenticationOptions({ rpID: config.rpId, userVerification: 'required' });
      const flow = token();
      await insertChallenge(pool, null, 'PASSKEY_AUTHENTICATION', options.challenge, flow);
      setCookie(res, FLOW_COOKIE, flow, FLOW_TTL, config.secureCookies);
      res.json({ options });
    } catch (error) { next(error); }
  });

  router.post('/login/verify', async (req, res) => {
    const input = responseSchema.safeParse(req.body);
    const flow = cookie(req, FLOW_COOKIE);
    const credentialId = input.success && typeof input.data.response.id === 'string' ? input.data.response.id : '';
    if (!input.success || !flow || !credentialId) return res.status(400).json({ error: 'Sign-in could not be completed.' });
    const attempt = await pool.query(
      "UPDATE auth_challenges SET attempt_count=attempt_count+1 WHERE flow_token_hash=$1 AND purpose='PASSKEY_AUTHENTICATION' AND consumed_at IS NULL AND expires_at>NOW() AND attempt_count<5 RETURNING id",
      [sha(flow)],
    );
    if (!attempt.rowCount) return res.status(400).json({ error: 'Sign-in expired or too many attempts. Try again.' });
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const challenge = await client.query(
        "SELECT id,challenge_hash FROM auth_challenges WHERE id=$1 AND consumed_at IS NULL AND expires_at>NOW() FOR UPDATE",
        [attempt.rows[0].id],
      );
      if (!challenge.rowCount) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'Sign-in expired. Try again.' }); }
      const found = await client.query(
        "SELECT p.credential_id,p.user_id,p.public_key,p.signature_counter,p.transports,u.status FROM user_passkey_credentials p JOIN users u ON u.id=p.user_id WHERE p.credential_id=$1 AND p.revoked_at IS NULL",
        [credentialId],
      );
      if (!found.rowCount || found.rows[0].status !== 'ACTIVE') { await client.query('ROLLBACK'); return res.status(401).json({ error: 'Passkey was not recognized.' }); }
      const p = found.rows[0];
      const verification = await verifyAuthenticationResponse({
        response: input.data.response as never,
        expectedChallenge: async (challengeValue) => equalHex(sha(challengeValue), challenge.rows[0].challenge_hash),
        expectedOrigin: config.origins,
        expectedRPID: config.rpId,
        requireUserVerification: true,
        credential: { id: p.credential_id, publicKey: new Uint8Array(p.public_key), counter: Number(p.signature_counter), transports: p.transports },
      });
      if (!verification.verified) { await client.query('ROLLBACK'); return res.status(401).json({ error: 'Passkey verification failed.' }); }
      await client.query("UPDATE auth_challenges SET consumed_at=NOW() WHERE id=$1", [challenge.rows[0].id]);
      await client.query("UPDATE user_passkey_credentials SET signature_counter=$1,last_used_at=NOW() WHERE credential_id=$2", [verification.authenticationInfo.newCounter, credentialId]);
      const session = await newSession(client, p.user_id);
      await client.query('COMMIT');
      clearCookie(res, FLOW_COOKIE, config.secureCookies);
      setCookie(res, SESSION_COOKIE, session.token, SESSION_TTL, config.secureCookies);
      res.json({ authenticated: true, csrfToken: session.csrfToken });
    } catch {
      await client.query('ROLLBACK').catch(() => undefined);
      res.status(401).json({ error: 'Passkey verification failed.' });
    } finally { client.release(); }
  });

  router.get('/me', requireSession, async (_req, res, next) => {
    try {
      const session = res.locals.authSession as { id: string; userId: string };
      const csrfToken = token();
      await pool.query("UPDATE auth_sessions SET csrf_token_hash=$1,last_used_at=NOW() WHERE id=$2", [sha(csrfToken), session.id]);
      const passkeys = await pool.query("SELECT credential_id,device_type,backed_up,created_at,last_used_at FROM user_passkey_credentials WHERE user_id=$1 AND revoked_at IS NULL ORDER BY created_at", [session.userId]);
      const recovery = await pool.query("SELECT acknowledged_at FROM user_recovery_codes WHERE user_id=$1 AND consumed_at IS NULL AND revoked_at IS NULL ORDER BY created_at DESC LIMIT 1", [session.userId]);
      res.json({ userId: session.userId, csrfToken, passkeys: passkeys.rows, recoveryCodeAcknowledged: Boolean(recovery.rows[0]?.acknowledged_at) });
    } catch (error) { next(error); }
  });

  router.post('/passkeys/register/options', requireSession, requireCsrf, async (_req, res, next) => {
    try {
      const session = res.locals.authSession as { userId: string };
      const options = await makeRegistrationOptions(pool, session.userId, config);
      const flow = token();
      await insertChallenge(pool, session.userId, 'PASSKEY_REGISTRATION', String(options.challenge), flow);
      setCookie(res, FLOW_COOKIE, flow, FLOW_TTL, config.secureCookies);
      res.json({ options });
    } catch (error) { next(error); }
  });

  router.post('/passkeys/register/verify', requireSession, requireCsrf, async (req, res) => {
    const input = responseSchema.safeParse(req.body);
    const flow = cookie(req, FLOW_COOKIE);
    const session = res.locals.authSession as { userId: string };
    if (!input.success || !flow) return res.status(400).json({ error: 'Passkey registration expired.' });
    const attempt = await pool.query(
      "UPDATE auth_challenges SET attempt_count=attempt_count+1 WHERE flow_token_hash=$1 AND user_id=$2 AND purpose='PASSKEY_REGISTRATION' AND consumed_at IS NULL AND expires_at>NOW() AND attempt_count<5 RETURNING id",
      [sha(flow), session.userId],
    );
    if (!attempt.rowCount) return res.status(400).json({ error: 'Passkey registration expired or too many attempts.' });
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const challenge = await client.query(
        "SELECT id,challenge_hash FROM auth_challenges WHERE id=$1 AND consumed_at IS NULL AND expires_at>NOW() FOR UPDATE",
        [attempt.rows[0].id],
      );
      if (!challenge.rowCount) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'Passkey registration expired.' }); }
      await saveCredential(client, session.userId, input.data.response, challenge.rows[0].challenge_hash, config);
      await client.query("UPDATE auth_challenges SET consumed_at=NOW() WHERE id=$1", [challenge.rows[0].id]);
      await client.query('COMMIT');
      clearCookie(res, FLOW_COOKIE, config.secureCookies);
      res.status(201).json({ registered: true });
    } catch {
      await client.query('ROLLBACK').catch(() => undefined);
      res.status(400).json({ error: 'Passkey registration failed.' });
    } finally { client.release(); }
  });

  router.delete('/passkeys/:credentialId', requireSession, requireCsrf, async (req, res, next) => {
    try {
      const session = res.locals.authSession as { userId: string };
      const count = await pool.query("SELECT count(*)::int AS count FROM user_passkey_credentials WHERE user_id=$1 AND revoked_at IS NULL", [session.userId]);
      if (count.rows[0].count <= 1) return res.status(409).json({ error: 'Register another passkey before revoking the last one.' });
      const removed = await pool.query("UPDATE user_passkey_credentials SET revoked_at=NOW() WHERE credential_id=$1 AND user_id=$2 AND revoked_at IS NULL RETURNING credential_id", [req.params.credentialId, session.userId]);
      if (!removed.rowCount) return res.status(404).json({ error: 'Passkey not found.' });
      res.json({ revoked: true });
    } catch (error) { next(error); }
  });

  router.post('/recovery/start', async (req, res, next) => {
    const input = recoveryStartSchema.safeParse(req.body);
    const generic = { message: 'If the recovery details are valid, a verification email will be sent.' };
    if (!input.success) return res.status(202).json(generic);
    const parts = parseCode(input.data.recoveryCode);
    const rateSubject = parts?.userId || sha(input.data.recoveryCode).slice(0, 36);
    try {
      const rate = await pool.query(
        "INSERT INTO auth_recovery_attempt_limits (subject_hash,window_started_at,attempts,locked_until) VALUES ($1,NOW(),1,NULL) ON CONFLICT (subject_hash) DO UPDATE SET attempts=CASE WHEN auth_recovery_attempt_limits.window_started_at<NOW()-INTERVAL '15 minutes' THEN 1 ELSE auth_recovery_attempt_limits.attempts+1 END, window_started_at=CASE WHEN auth_recovery_attempt_limits.window_started_at<NOW()-INTERVAL '15 minutes' THEN NOW() ELSE auth_recovery_attempt_limits.window_started_at END, locked_until=CASE WHEN auth_recovery_attempt_limits.locked_until>NOW() THEN auth_recovery_attempt_limits.locked_until WHEN (CASE WHEN auth_recovery_attempt_limits.window_started_at<NOW()-INTERVAL '15 minutes' THEN 1 ELSE auth_recovery_attempt_limits.attempts+1 END)>=$2 THEN NOW()+INTERVAL '15 minutes' ELSE NULL END RETURNING attempts,locked_until",
        [sha('recovery:' + rateSubject), MAX_RECOVERY_ATTEMPTS],
      );
      if (rate.rows[0].locked_until && new Date(rate.rows[0].locked_until).getTime() > Date.now()) return res.status(202).json(generic);
      if (!parts) return res.status(202).json(generic);
      const saved = await pool.query("SELECT r.code_salt,r.code_hash,u.status FROM user_recovery_codes r JOIN users u ON u.id=r.user_id WHERE r.user_id=$1 AND r.consumed_at IS NULL AND r.revoked_at IS NULL", [parts.userId]);
      if (!saved.rowCount || saved.rows[0].status !== 'ACTIVE') return res.status(202).json(generic);
      if (!equalHex(recoveryHash(parts.secret, saved.rows[0].code_salt), saved.rows[0].code_hash)) return res.status(202).json(generic);

      const emailToken = token();
      const challengeId = randomUUID();
      await pool.query("INSERT INTO auth_challenges (id,user_id,challenge_hash,purpose,expires_at) VALUES ($1,$2,$3,'RECOVERY_EMAIL_VERIFICATION',NOW()+($4*INTERVAL '1 minute'))", [challengeId, parts.userId, sha(emailToken), RECOVERY_EMAIL_TTL]);
      const url = new URL('/recover/verify', config.appBaseUrl);
      url.searchParams.set('token', emailToken);
      try {
        await emailProvider.sendRecoveryVerificationEmail({ to: input.data.email, verificationUrl: url.toString(), expiresInMinutes: RECOVERY_EMAIL_TTL });
      } catch {
        await pool.query("DELETE FROM auth_challenges WHERE id=$1 AND consumed_at IS NULL", [challengeId]);
        return res.status(503).json({ error: 'Recovery email could not be sent. Try again later.' });
      }
      return res.status(202).json(generic);
    } catch (error) { next(error); }
  });

  router.post('/recovery/verify-email', async (req, res, next) => {
    const input = recoveryVerifySchema.safeParse(req.body);
    if (!input.success) return res.status(400).json({ error: 'Recovery link is invalid or expired.' });
    const attempt = await pool.query(
      "UPDATE auth_challenges SET attempt_count=attempt_count+1 WHERE challenge_hash=$1 AND purpose='RECOVERY_EMAIL_VERIFICATION' AND consumed_at IS NULL AND expires_at>NOW() AND attempt_count<5 RETURNING id",
      [sha(input.data.token)],
    );
    if (!attempt.rowCount) return res.status(400).json({ error: 'Recovery link is invalid or expired.' });
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const found = await client.query("SELECT id,user_id FROM auth_challenges WHERE id=$1 AND consumed_at IS NULL AND expires_at>NOW() FOR UPDATE", [attempt.rows[0].id]);
      if (!found.rowCount) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'Recovery link is invalid or expired.' }); }
      const userId = found.rows[0].user_id as string;
      const options = await makeRegistrationOptions(pool, userId, config);
      const flow = token();
      await client.query("UPDATE auth_challenges SET consumed_at=NOW() WHERE id=$1", [found.rows[0].id]);
      await insertChallenge(client, userId, 'RECOVERY_PASSKEY_REGISTRATION', String(options.challenge), flow, 600);
      await client.query('COMMIT');
      setCookie(res, FLOW_COOKIE, flow, 600, config.secureCookies);
      res.json({ options });
    } catch (error) { await client.query('ROLLBACK').catch(() => undefined); next(error); }
    finally { client.release(); }
  });

  router.post('/recovery/verify-passkey', async (req, res) => {
    const input = responseSchema.safeParse(req.body);
    const flow = cookie(req, FLOW_COOKIE);
    if (!input.success || !flow) return res.status(400).json({ error: 'Recovery session expired. Start again.' });
    const attempt = await pool.query(
      "UPDATE auth_challenges SET attempt_count=attempt_count+1 WHERE flow_token_hash=$1 AND purpose='RECOVERY_PASSKEY_REGISTRATION' AND consumed_at IS NULL AND expires_at>NOW() AND attempt_count<5 RETURNING id",
      [sha(flow)],
    );
    if (!attempt.rowCount) return res.status(400).json({ error: 'Recovery session expired or too many attempts. Start again.' });
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const challenge = await client.query("SELECT id,user_id,challenge_hash FROM auth_challenges WHERE id=$1 AND consumed_at IS NULL AND expires_at>NOW() FOR UPDATE", [attempt.rows[0].id]);
      if (!challenge.rowCount) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'Recovery session expired. Start again.' }); }
      const userId = challenge.rows[0].user_id as string;
      await saveCredential(client, userId, input.data.response, challenge.rows[0].challenge_hash, config);
      await client.query("UPDATE auth_challenges SET consumed_at=NOW() WHERE id=$1", [challenge.rows[0].id]);
      await client.query("UPDATE user_recovery_codes SET consumed_at=NOW() WHERE user_id=$1 AND consumed_at IS NULL AND revoked_at IS NULL", [userId]);
      await client.query("UPDATE auth_sessions SET revoked_at=NOW() WHERE user_id=$1 AND revoked_at IS NULL", [userId]);
      const recoveryCode = await saveNewRecoveryCode(client, userId);
      const session = await newSession(client, userId);
      await client.query('COMMIT');
      clearCookie(res, FLOW_COOKIE, config.secureCookies);
      setCookie(res, SESSION_COOKIE, session.token, SESSION_TTL, config.secureCookies);
      res.status(201).json({ recovered: true, recoveryCode, csrfToken: session.csrfToken, reviewPasskeys: true });
    } catch {
      await client.query('ROLLBACK').catch(() => undefined);
      res.status(400).json({ error: 'Recovery could not be completed. Start again.' });
    } finally { client.release(); }
  });

  router.post('/recovery-code/acknowledge', requireSession, requireCsrf, async (req, res, next) => {
    const input = z.object({ recoveryCode: z.string().min(30).max(180) }).safeParse(req.body);
    if (!input.success) return res.status(400).json({ error: 'Recovery code acknowledgement failed.' });
    try {
      const session = res.locals.authSession as { userId: string };
      const parts = parseCode(input.data.recoveryCode);
      if (!parts || parts.userId !== session.userId) return res.status(400).json({ error: 'Recovery code acknowledgement failed.' });
      const saved = await pool.query("SELECT id,code_salt,code_hash FROM user_recovery_codes WHERE user_id=$1 AND consumed_at IS NULL AND revoked_at IS NULL ORDER BY created_at DESC LIMIT 1", [session.userId]);
      if (!saved.rowCount || !equalHex(recoveryHash(parts.secret, saved.rows[0].code_salt), saved.rows[0].code_hash)) {
        return res.status(400).json({ error: 'Recovery code acknowledgement failed.' });
      }
      await pool.query("UPDATE user_recovery_codes SET acknowledged_at=COALESCE(acknowledged_at,NOW()) WHERE id=$1", [saved.rows[0].id]);
      res.json({ acknowledged: true });
    } catch (error) { next(error); }
  });

  router.post('/logout', requireSession, requireCsrf, async (_req, res, next) => {
    try {
      const session = res.locals.authSession as { id: string };
      await pool.query("UPDATE auth_sessions SET revoked_at=NOW() WHERE id=$1", [session.id]);
      clearCookie(res, SESSION_COOKIE, config.secureCookies);
      res.json({ signedOut: true });
    } catch (error) { next(error); }
  });

  return router;
}
