import type { RTCIceServerLike, VoiceConfig } from '../../../shared/protocol';
import { fail, json, type Env } from '../../env';
import { directory } from '../directory/Directory';
import { authorised } from '../rides/routes';

const REALTIME = 'https://rtc.live.cloudflare.com/v1';
const FALLBACK_ICE: RTCIceServerLike[] = [{ urls: 'stun:stun.cloudflare.com:3478' }];
const SESSION_ID = /^[A-Za-z0-9_-]{1,128}$/;

async function iceServers(env: Env, relayOn: boolean): Promise<RTCIceServerLike[]> {
  // TURN shares the relay's allowance, so when that is off only free STUN is offered.
  if (!relayOn || !env.TURN_KEY_ID || !env.TURN_KEY_TOKEN) return FALLBACK_ICE;
  const res = await fetch(`${REALTIME}/turn/keys/${env.TURN_KEY_ID}/credentials/generate-ice-servers`, {
    method: 'POST',
    headers: { authorization: `Bearer ${env.TURN_KEY_TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify({ ttl: 86400 }),
  });
  if (!res.ok) return FALLBACK_ICE;
  const { iceServers: servers } = await res.json<{ iceServers: RTCIceServerLike[] }>();
  // Cloudflare's docs warn that port 53 URLs can time out in browsers.
  return servers.map((s) => ({
    ...s,
    urls: ([] as string[]).concat(s.urls).filter((u) => !/:53(\?|$)/.test(u)),
  }));
}

/** Forwards one call to the SFU. The app secret never reaches a client. */
async function sfu(env: Env, method: string, path: string, body?: string): Promise<Response> {
  const res = await fetch(`${REALTIME}/apps/${env.SFU_APP_ID}${path}`, {
    method,
    headers: { authorization: `Bearer ${env.SFU_APP_SECRET}`, 'content-type': 'application/json' },
    ...(body ? { body } : {}),
  });
  return new Response(res.body, { status: res.status, headers: { 'content-type': 'application/json' } });
}

export async function voiceRoutes(request: Request, env: Env, path: string[]): Promise<Response | undefined> {
  const [, resource, code, area, action, sessionId] = path;
  if (resource !== 'rides' || area !== 'voice' || !code) return undefined;
  if (!(await authorised(env, code, request.headers.get('x-rider'), request.headers.get('x-token')))) {
    return fail(401, 'Not on this ride');
  }

  // Past the lock line, voice uses direct links, so relay data can never run into charges.
  const relayOn = (await directory(env).policy()).relay;
  const sfuReady = !!env.SFU_APP_ID && !!env.SFU_APP_SECRET && relayOn;
  if (action === 'config') {
    return json({ mode: sfuReady ? 'sfu' : 'mesh', iceServers: await iceServers(env, relayOn) } satisfies VoiceConfig);
  }

  if (!sfuReady) return fail(503, 'Voice relay is not configured');
  if (action === 'session' && request.method === 'POST') return sfu(env, 'POST', '/sessions/new');
  if (!sessionId || !SESSION_ID.test(sessionId)) return fail(400, 'Bad session');

  const body = await request.text();
  if (action === 'tracks' && request.method === 'POST') return sfu(env, 'POST', `/sessions/${sessionId}/tracks/new`, body);
  if (action === 'renegotiate' && request.method === 'PUT') return sfu(env, 'PUT', `/sessions/${sessionId}/renegotiate`, body);
  if (action === 'close' && request.method === 'PUT') return sfu(env, 'PUT', `/sessions/${sessionId}/tracks/close`, body);
  return fail(404, 'Unknown voice action');
}
