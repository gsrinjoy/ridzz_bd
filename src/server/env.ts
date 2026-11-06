import type { Directory } from './modules/directory/Directory';
import type { RideRoom } from './modules/rides/RideRoom';

export interface Env {
  RIDES: DurableObjectNamespace<RideRoom>;
  DIRECTORY: DurableObjectNamespace<Directory>;
  ASSETS: Fetcher;
  TOKEN_SECRET: string;
  /** The owner's password for /admin. With none set, the portal stays locked. */
  ADMIN_TOKEN?: string;
  /** Cloudflare Realtime. Without these, voice falls back to direct peer-to-peer. */
  SFU_APP_ID?: string;
  SFU_APP_SECRET?: string;
  TURN_KEY_ID?: string;
  TURN_KEY_TOKEN?: string;
  /** Mappls static key. Public by nature, so lock it to your domain in the Mappls console. */
  MAPPLS_KEY?: string;
  /** Optional in-app Google search. Google requires a billing account for this. */
  GOOGLE_PLACES_KEY?: string;
}

export const json = (data: unknown, status = 200, headers: HeadersInit = {}) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json', 'x-content-type-options': 'nosniff', 'cache-control': 'no-store', ...headers },
  });

export const fail = (status: number, error: string) => json({ error }, status);
