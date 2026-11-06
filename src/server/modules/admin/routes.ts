import type { AdminOverview, AdminRide } from '../../../shared/protocol';
import { fail, json, type Env } from '../../env';
import { directory } from '../directory/Directory';
import { isRideCode, safeEqual } from '../rides/auth';
import { room } from '../rides/routes';

function isOwner(request: Request, env: Env): boolean {
  // No token configured means no owner access at all, never open access.
  if (!env.ADMIN_TOKEN) return false;
  const given = request.headers.get('authorization')?.replace(/^Bearer /, '') ?? '';
  return safeEqual(given, env.ADMIN_TOKEN);
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

export async function adminRoutes(request: Request, env: Env, path: string[]): Promise<Response | undefined> {
  const [, resource, area, id, action] = path;
  if (resource !== 'admin') return undefined;
  if (!isOwner(request, env)) return fail(401, 'Wrong owner password');
  const dir = directory(env);

  if (request.method === 'GET' && area === 'overview') {
    const [rides, users, { friendships }] = await Promise.all([allRides(env), dir.listUsers(), dir.counts()]);
    const online = rides.flatMap((r) => r.riders).filter((r) => r.online);
    return json({
      users: users.length,
      blockedUsers: users.filter((u) => u.blocked).length,
      friendships,
      rides: rides.length,
      liveRides: rides.filter((r) => r.riders.some((x) => x.online)).length,
      ridersOnline: online.length,
      services: { voiceRelay: !!env.SFU_APP_ID && !!env.SFU_APP_SECRET, turn: !!env.TURN_KEY_ID, mappls: !!env.MAPPLS_KEY },
    } satisfies AdminOverview);
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
      return json({ ok: true });
    }
    if (request.method === 'DELETE' && !action) {
      await dir.deleteUser(id);
      return json({ ok: true });
    }
  }
  return fail(404, 'Not found');
}
