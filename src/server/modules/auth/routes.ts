import { RIDER_COLORS, type Account, type Registered } from '../../../shared/protocol';
import { fail, json, type Env } from '../../env';
import { directory, type UserRow } from '../directory/Directory';
import { passwordProblem, validEmail } from './passwords';

const MINUTE = 60_000;
/** Enough for a group of friends joining at once, and a ceiling on what strangers can add. */
const MAX_PENDING = 20;

const cleanName = (v: unknown) => (typeof v === 'string' ? v.trim().slice(0, 24) : '');
const cleanColor = (v: unknown) => (typeof v === 'string' && RIDER_COLORS.includes(v) ? v : (RIDER_COLORS[0] as string));
const cleanEmail = (v: unknown) => (typeof v === 'string' ? v.trim().toLowerCase() : '');

export const clientIp = (request: Request) => request.headers.get('cf-connecting-ip') ?? 'local';

const bearer = (request: Request) => request.headers.get('authorization')?.replace(/^Bearer /, '') ?? '';

const toAccount = (user: UserRow, token: string): Account => ({ userId: user.id, token, name: user.name, color: user.color, friendCode: user.friend_code, approved: !!user.approved });

/** Resolves the caller, or returns the error response to send back. */
export async function currentUser(request: Request, env: Env, allowPending = false): Promise<UserRow | Response> {
  const token = bearer(request);
  if (!token) return fail(401, 'Please sign in');
  const user = await directory(env).authenticate(token);
  if (!user) return fail(401, 'Please sign in again');
  if (user.blocked) return fail(403, 'This account has been blocked');
  // The app is private: an account does nothing until the owner approves it.
  if (!user.approved && !allowPending) return json({ error: 'Waiting for the owner to approve your account', pending: true }, 403);
  return user;
}

export async function authRoutes(request: Request, env: Env, path: string[]): Promise<Response | undefined> {
  const [, resource, action] = path;
  if (resource !== 'auth') return undefined;
  if (request.method === 'GET' && action === 'me') {
    const me = await currentUser(request, env, true);
    return me instanceof Response ? me : json({ approved: !!me.approved });
  }
  if (request.method !== 'POST') return undefined;
  const dir = directory(env);
  const ip = clientIp(request);
  const body = await request.json<Record<string, unknown>>().catch(() => ({}) as Record<string, unknown>);

  if (action === 'register') {
    // Generous, because a whole group can sign up at once on one phone's hotspot.
    if (!(await dir.allow(`register:${ip}`, 30, 60 * MINUTE))) return fail(429, 'Too many new accounts from here. Try again later.');
    const name = cleanName(body.name);
    const email = cleanEmail(body.email);
    if (!name) return fail(400, 'Enter your name');
    if (!validEmail(email)) return fail(400, 'Enter a valid email address');
    const problem = passwordProblem(body.password);
    if (problem) return fail(400, problem);
    if ((await dir.pendingCount()) >= MAX_PENDING) return fail(429, 'Sign-ups are paused for now. Ask the owner.');
    const made = await dir.register(name, cleanColor(body.color), email, body.password as string);
    if (!made) return fail(409, 'That email already has an account. Sign in instead.');
    return json({ account: toAccount(made.user, made.token), recoveryCode: made.recoveryCode } satisfies Registered);
  }

  if (action === 'login') {
    const email = cleanEmail(body.email);
    // Limited per address and per network, so neither guessing one account nor many gets far.
    if (!(await dir.allow(`login:${email}`, 5, 15 * MINUTE)) || !(await dir.allow(`login-ip:${ip}`, 30, 15 * MINUTE))) {
      return fail(429, 'Too many attempts. Wait 15 minutes and try again.');
    }
    const found = await dir.login(email, typeof body.password === 'string' ? body.password : '');
    // One message for both cases, so this cannot reveal which emails have accounts.
    if (!found) return fail(401, 'Wrong email or password');
    if (found.user.blocked) return fail(403, 'This account has been blocked');
    await dir.clearAttempts(`login:${email}`);
    return json(toAccount(found.user, found.token));
  }

  if (action === 'recover') {
    const email = cleanEmail(body.email);
    if (!(await dir.allow(`recover:${email}`, 5, 60 * MINUTE)) || !(await dir.allow(`recover-ip:${ip}`, 20, 60 * MINUTE))) {
      return fail(429, 'Too many attempts. Try again in an hour.');
    }
    const problem = passwordProblem(body.password);
    if (problem) return fail(400, problem);
    const done = await dir.recover(email, typeof body.code === 'string' ? body.code : '', body.password as string);
    if (!done) return fail(401, 'That email and recovery code do not match');
    return json({ account: toAccount(done.user, done.token), recoveryCode: done.recoveryCode } satisfies Registered);
  }

  const me = await currentUser(request, env, true);
  if (me instanceof Response) return me;

  if (action === 'logout') {
    await dir.logout(bearer(request));
    return json({ ok: true });
  }

  if (action === 'password') {
    if (!(await dir.allow(`password:${me.id}`, 5, 15 * MINUTE))) return fail(429, 'Too many attempts. Wait 15 minutes and try again.');
    const problem = passwordProblem(body.next);
    if (problem) return fail(400, problem);
    const token = await dir.changePassword(me.id, typeof body.current === 'string' ? body.current : '', body.next as string);
    // Not a 401: the session is fine, and the app treats a 401 as being signed out.
    if (!token) return fail(400, 'Your current password is not right');
    return json(toAccount(me, token));
  }
  return undefined;
}
