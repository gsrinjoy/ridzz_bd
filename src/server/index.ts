import type { AppConfig } from '../shared/protocol';
import { fail, json, type Env } from './env';
import { adminRoutes } from './modules/admin/routes';
import { directoryRoutes } from './modules/directory/routes';
import { placesRoutes } from './modules/places/routes';
import { ridesRoutes } from './modules/rides/routes';
import { voiceRoutes } from './modules/voice/routes';

export { Directory } from './modules/directory/Directory';
export { RideRoom } from './modules/rides/RideRoom';

// Order matters: voice paths sit under /rides, so they are tried first.
const modules = [adminRoutes, directoryRoutes, voiceRoutes, ridesRoutes, placesRoutes];

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (!env.TOKEN_SECRET) return fail(500, 'TOKEN_SECRET is not set');
    const path = new URL(request.url).pathname.split('/').filter(Boolean);
    if (path[0] !== 'api') return env.ASSETS.fetch(request);
    if (path[1] === 'config') return json({ mapplsKey: env.MAPPLS_KEY ?? null } satisfies AppConfig);
    for (const handle of modules) {
      const response = await handle(request, env, path);
      if (response) return response;
    }
    return fail(404, 'Not found');
  },
} satisfies ExportedHandler<Env>;
