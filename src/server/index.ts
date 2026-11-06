import type { AppConfig } from '../shared/protocol';
import { fail, json, type Env } from './env';
import { adminRoutes } from './modules/admin/routes';
import { directory } from './modules/directory/Directory';
import { authRoutes, currentUser } from './modules/auth/routes';
import { directoryRoutes } from './modules/directory/routes';
import { mapFile, placesRoutes } from './modules/places/routes';
import { ridesRoutes } from './modules/rides/routes';
import { voiceRoutes } from './modules/voice/routes';

export { Directory } from './modules/directory/Directory';
export { RideRoom } from './modules/rides/RideRoom';

// Order matters: voice paths sit under /rides, so they are tried first.
const modules = [authRoutes, adminRoutes, directoryRoutes, voiceRoutes, ridesRoutes, placesRoutes];

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    if (!env.TOKEN_SECRET) return fail(500, 'TOKEN_SECRET is not set');
    const path = new URL(request.url).pathname.split('/').filter(Boolean);
    if (path[0] !== 'api') return env.ASSETS.fetch(request);
    if (path[1] === 'config') {
      // The app is private, so even this browser-side key is for riders only.
      const user = await currentUser(request, env);
      return user instanceof Response ? user : json({ mapplsKey: env.MAPPLS_KEY ?? null } satisfies AppConfig);
    }
    if (path[1] === 'map' && path[2] === 'file') {
      // One screen of map is dozens of these, so usage is sampled rather than paying a database call for each.
      if (Math.random() < 0.05) ctx.waitUntil(directory(env).addUsage({ worker_requests: 20, do_requests: 1 }));
      return mapFile(request, path.slice(3).join('/'));
    }
    // Each API call is a Worker request plus, usually, a Durable Object one.
    ctx.waitUntil(directory(env).addUsage({ worker_requests: 1, do_requests: 2 }));
    for (const handle of modules) {
      const response = await handle(request, env, path);
      if (response) return response;
    }
    return fail(404, 'Not found');
  },
} satisfies ExportedHandler<Env>;
