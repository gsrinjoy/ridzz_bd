import type { AdminOverview, AdminRide } from '../../../shared/protocol';
import { fail, json, type Env } from '../../env';
import { passwordProblem } from '../auth/passwords';
import { clientIp } from '../auth/routes';
import { directory } from '../directory/Directory';
import { isRideCode, safeEqual } from '../rides/auth';
import { room } from '../rides/routes';

async function isOwner(request: Request, env: Env): Promise<boolean> {
  // No token configured means no owner access at all, never open access.
  if (!env.ADMIN_TOKEN) return false;
  const given = request.headers.get('authorization')?.replace(/^Bearer /, '') ?? '';
  if (!given) return false;
  const dir = directory(env);
  if (await dir.isOwnerSession(given)) return true;
  return safeEqual(given, env.ADMIN_TOKEN) && (await dir.tokenIsPassword(env.ADMIN_TOKEN));
}

async function allRides(env: Env): Promise<AdminRide[]> {
  const rides = await directory(env).listRides();
  return Promise.all(
    rides.map(async (r) => ({
      code: r.code,
      name: r.name,
      owner: r.owner,
      createdAt: r.created_at,
      lastActive: r.last_active,
      ...(await room(env, r.code).snapshot()),
    })),
  );
}

/** A live ride socket does not pass through login again, so a block has to reach it directly. */
async function removeFromRides(env: Env, userId: string): Promise<void> {
  const rides = await directory(env).listRides();
  await Promise.all(rides.map((r) => room(env, r.code).kick(userId)));
}

export async function adminRoutes(request: Request, env: Env, path: string[]): Promise<Response | undefined> {
  const [, resource, area, id, action] = path;
  if (resource !== 'admin') return undefined;
  const dir = directory(env);
  const limited = () => fail(429, 'Too many attempts. Wait 15 minutes.');

  if (area === 'login' && request.method === 'POST' && env.ADMIN_TOKEN) {
    const { password } = await request.json<{ password?: string }>().catch(() => ({ password: '' }));
    if (!(await dir.allow(`admin:${clientIp(request)}`, 10, 15 * 60_000))) return limited();
    const token = await dir.ownerLogin(password ?? '', env.ADMIN_TOKEN);
    if (!token) return fail(401, 'Wrong owner password');
    await dir.clearAttempts(`admin:${clientIp(request)}`);
    return json({ token });
  }

  if (!(await isOwner(request, env))) {
    // Failures alone are counted, so the portal's own polling never locks the owner out.
    if (!(await dir.allow(`admin:${clientIp(request)}`, 10, 15 * 60_000))) return limited();
    return fail(401, 'Wrong owner password');
  }

  if (area === 'password' && request.method === 'POST') {
    const { current, next } = await request.json<{ current?: string; next?: string }>();
    const problem = passwordProblem(next);
    if (problem) return fail(400, problem);
    if (!(await dir.allow(`admin-password:${clientIp(request)}`, 5, 15 * 60_000))) return limited();
    const changed = await dir.changeOwnerPassword(current ?? '', next as string, env.ADMIN_TOKEN as string);
    return changed ? json({ ok: true }) : fail(400, 'Your current password is not right');
  }

  if (request.method === 'GET' && area === 'overview') {
    const [rides, users, { friendships }] = await Promise.all([allRides(env), dir.listUsers(), dir.counts()]);
    const online = rides.flatMap((r) => r.riders).filter((r) => r.online);
    return json({
      users: users.length,
      pendingUsers: users.filter((u) => !u.approved).length,
      blockedUsers: users.filter((u) => u.blocked).length,
      friendships,
      rides: rides.length,
      liveRides: rides.filter((r) => r.riders.some((x) => x.online)).length,
      ridersOnline: online.length,
      services: { voiceRelay: !!env.SFU_APP_ID && !!env.SFU_APP_SECRET, turn: !!env.TURN_KEY_ID, mappls: !!env.MAPPLS_KEY },
      policy: await dir.policy(),
      relayForcedOff: await dir.relayForcedOff(),
      budgets: await dir.budgets(),
    } satisfies AdminOverview);
  }

  if (request.method === 'POST' && area === 'voice-relay') {
    const { on } = await request.json<{ on?: boolean }>();
    await dir.setRelayForcedOff(on !== true);
    // Riders on a call right now move over at once.
    const rides = await dir.listRides();
    await Promise.all(rides.map((r) => room(env, r.code).refreshPolicy()));
    return json({ ok: true });
  }

  if (request.method === 'GET' && area === 'rides') return json(await allRides(env));
  if (request.method === 'GET' && area === 'users') return json(await dir.listUsers());

  if (request.method === 'POST' && area === 'rides' && id && isRideCode(id)) {
    if (action === 'end') {
      await room(env, id).end();
      return json({ ok: true });
    }
    if (action === 'kick') {
      const { riderId } = await request.json<{ riderId?: string }>();
      if (!riderId) return fail(400, 'Which rider?');
      await room(env, id).kick(riderId);
      return json({ ok: true });
    }
  }

  if (area === 'users' && id) {
    if (request.method === 'POST' && action === 'block') {
      const { blocked } = await request.json<{ blocked?: boolean }>();
      await dir.setBlocked(id, blocked === true);
      if (blocked) await removeFromRides(env, id);
      return json({ ok: true });
    }
    if (request.method === 'POST' && action === 'approve') {
      await dir.approve(id);
      return json({ ok: true });
    }
    if (request.method === 'POST' && action === 'reset-password') {
      const temporary = await dir.ownerResetPassword(id);
      return temporary ? json({ temporary }) : fail(404, 'No such user');
    }
    if (request.method === 'GET' && action === 'stats') return json(await dir.listLogs(id));
    if (request.method === 'DELETE' && !action) {
      await dir.deleteUser(id);
      await removeFromRides(env, id);
      return json({ ok: true });
    }
  }
  return fail(404, 'Not found');
}
