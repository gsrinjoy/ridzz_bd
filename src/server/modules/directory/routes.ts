import { RIDER_COLORS } from '../../../shared/protocol';
import type { RideLog } from '../../../shared/stats';
import { fail, json, type Env } from '../../env';
import { currentUser } from '../auth/routes';
import { isRideCode } from '../rides/auth';
import { directory } from './Directory';

/** Comfortably above a full day's log, and well below a Durable Object row's limit. */
const MAX_LOG_BYTES = 400_000;

const cleanName = (v: unknown) => (typeof v === 'string' ? v.trim().slice(0, 24) : '');
const cleanColor = (v: unknown) => (typeof v === 'string' && RIDER_COLORS.includes(v) ? v : (RIDER_COLORS[0] as string));

export async function directoryRoutes(request: Request, env: Env, path: string[]): Promise<Response | undefined> {
  const [, resource, first, second] = path;
  if (resource !== 'accounts' && resource !== 'friends' && resource !== 'stats') return undefined;
  const dir = directory(env);
  const body = () => request.json<Record<string, unknown>>().catch(() => ({}) as Record<string, unknown>);

  const me = await currentUser(request, env);
  if (me instanceof Response) return me;

  if (resource === 'accounts' && first === 'me' && request.method === 'PATCH') {
    const input = await body();
    await dir.updateUser(me.id, cleanName(input.name) || me.name, cleanColor(input.color ?? me.color));
    return json({ ok: true });
  }

  if (resource === 'stats') {
    if (request.method === 'GET' && !first) return json(await dir.listLogs(me.id));
    if (request.method === 'GET' && first) {
      const log = await dir.getLog(me.id, decodeURIComponent(first));
      return log ? json(log) : fail(404, 'No such ride');
    }
    if (request.method === 'POST' && !first) {
      const raw = await request.text();
      if (raw.length > MAX_LOG_BYTES) return fail(413, 'Ride log is too large');
      const log = JSON.parse(raw) as RideLog;
      if (typeof log.id !== 'string' || !/^\d{4}-\d{2}-\d{2}:[A-Z0-9]{6}$/.test(log.id) || !Array.isArray(log.track)) return fail(400, 'Bad ride log');
      await dir.saveLog(me.id, log);
      return json({ ok: true });
    }
    return undefined;
  }

  if (resource !== 'friends') return undefined;
  if (request.method === 'GET' && !first) return json(await dir.friends(me.id));

  if (request.method === 'POST' && first === 'request') {
    const { target } = await body();
    if (typeof target !== 'string' || !target.trim()) return fail(400, 'Enter a friend code');
    const status = await dir.requestFriend(me.id, target.trim());
    if (status === 'unknown') return fail(404, 'No rider with that code');
    if (status === 'self') return fail(400, 'That is your own code');
    return json({ status });
  }

  if (request.method === 'POST' && first === 'respond') {
    const { id, accept } = await body();
    if (typeof id !== 'string') return fail(400, 'Bad request');
    return (await dir.respond(me.id, id, accept === true)) ? json({ ok: true }) : fail(404, 'That request is gone');
  }

  if (first === 'invites' && second && request.method === 'DELETE') {
    await dir.dismissInvite(me.id, second);
    return json({ ok: true });
  }

  if (first && second === 'invite' && request.method === 'POST') {
    const { code } = await body();
    if (typeof code !== 'string' || !isRideCode(code)) return fail(400, 'Bad ride code');
    return (await dir.inviteToRide(me.id, first, code)) ? json({ ok: true }) : fail(403, 'You can only invite friends');
  }

  if (first && !second && request.method === 'DELETE') {
    await dir.removeFriend(me.id, first);
    return json({ ok: true });
  }
  return undefined;
}
