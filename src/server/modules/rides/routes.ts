import type { JoinResponse } from '../../../shared/protocol';
import { fail, json, type Env } from '../../env';
import { directory } from '../directory/Directory';
import { currentUser } from '../auth/routes';
import { isRideCode, newRideCode, signRider, verifyRider } from './auth';

export const room = (env: Env, code: string) => env.RIDES.get(env.RIDES.idFromName(code));

const cleanName = (v: unknown, fallback: string) => (typeof v === 'string' ? v.trim().slice(0, 40) : '') || fallback;

async function enrol(env: Env, code: string, user: { id: string; name: string; color: string }): Promise<Response> {
  const status = await room(env, code).join(user.id, user.name, user.color);
  if (status === 'missing') return fail(404, 'No ride with that code');
  if (status === 'full') return fail(409, 'This ride is full');
  if (status === 'kicked') return fail(403, 'You were removed from this ride');
  if (status === 'finished') return fail(409, 'This ride has finished');
  return json({ code, riderId: user.id, token: await signRider(env.TOKEN_SECRET, code, user.id) } satisfies JoinResponse);
}

export async function authorised(env: Env, code: string, riderId: string | null, token: string | null): Promise<boolean> {
  return !!riderId && !!token && isRideCode(code) && verifyRider(env.TOKEN_SECRET, code, riderId, token);
}

export async function ridesRoutes(request: Request, env: Env, path: string[]): Promise<Response | undefined> {
  const [, resource, code, action] = path;
  if (resource !== 'rides') return undefined;

  if (request.method === 'POST' && !code) {
    const user = await currentUser(request, env);
    if (user instanceof Response) return user;
    const input = await request.json<Record<string, unknown>>().catch(() => ({}) as Record<string, unknown>);
    const newCode = newRideCode();
    const name = cleanName(input.rideName, `${user.name}'s ride`);
    await room(env, newCode).create(newCode, name, user.id);
    await directory(env).registerRide(newCode, name, user.id);
    return enrol(env, newCode, user);
  }

  if (!code || !isRideCode(code)) return fail(400, 'Bad ride code');

  if (request.method === 'POST' && action === 'join') {
    const user = await currentUser(request, env);
    if (user instanceof Response) return user;
    // Slows anyone trying to guess ride codes.
    if (!(await directory(env).allow(`join:${user.id}`, 30, 10 * 60_000))) return fail(429, 'Too many tries. Wait a few minutes.');
    return enrol(env, code, user);
  }

  if (action === 'ws') {
    if (request.headers.get('upgrade') !== 'websocket') return fail(426, 'WebSocket required');
    const url = new URL(request.url);
    // Browsers send Origin on sockets and do not apply the same-origin rule, so this check is ours to make.
    const origin = request.headers.get('origin');
    if (origin && new URL(origin).host !== url.host) return fail(403, 'Wrong origin');
    if (!(await authorised(env, code, url.searchParams.get('rider'), url.searchParams.get('token')))) return fail(401, 'Not on this ride');
    return room(env, code).fetch(request);
  }
  return undefined;
}
