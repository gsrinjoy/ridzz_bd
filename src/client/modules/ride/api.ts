import type { Account, AppConfig, FriendsView, JoinResponse, PlaceHit, Registered, RouteResult } from '../../../shared/protocol';
import type { LatLng } from '../../../shared/geo';
import type { ParsedPlace } from '../../../shared/mapsLink';
import type { RideLog, RideSummary } from '../../../shared/stats';
import { account, setAccount } from '../../app/store';

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const a = account.peek();
  const res = await fetch(path, {
    ...init,
    headers: { 'content-type': 'application/json', ...(a ? { authorization: `Bearer ${a.token}` } : {}), ...init?.headers },
  });
  const data = (await res.json().catch(() => ({}))) as T & { error?: string };
  // The session expired or was revoked, so the rider has to sign in again.
  if (res.status === 401 && a) setAccount(null);
  if (!res.ok) throw new Error(data.error ?? 'Could not reach the server');
  return data;
}

const send = <T>(method: string, path: string, body?: unknown) =>
  call<T>(path, { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });

export const fetchConfig = () => call<AppConfig>('/api/config');

export const register = (name: string, color: string, email: string, password: string) =>
  send<Registered>('POST', '/api/auth/register', { name, color, email, password });
export const login = (email: string, password: string) => send<Account>('POST', '/api/auth/login', { email, password });
export const recoverAccount = (email: string, code: string, password: string) =>
  send<Registered>('POST', '/api/auth/recover', { email, code, password });
export const changePassword = (current: string, next: string) => send<Account>('POST', '/api/auth/password', { current, next });
export const signOutSession = () => send('POST', '/api/auth/logout', {});
export const updateProfile = (name: string, color: string) => send('PATCH', '/api/accounts/me', { name, color });

export const createRide = () => send<JoinResponse>('POST', '/api/rides', {});
export const joinRide = (code: string) => send<JoinResponse>('POST', `/api/rides/${code}/join`, {});

export const saveRideLog = (log: RideLog) => send('POST', '/api/stats', log);
export const fetchRideLogs = () => call<RideSummary[]>('/api/stats');
export const fetchRideLog = (id: string) => call<RideLog>(`/api/stats/${encodeURIComponent(id)}`);

export const fetchFriends = () => call<FriendsView>('/api/friends');
export const requestFriend = (target: string) => send<{ status: 'sent' | 'friends' }>('POST', '/api/friends/request', { target });
export const respondFriend = (id: string, accept: boolean) => send('POST', '/api/friends/respond', { id, accept });
export const removeFriend = (id: string) => send('DELETE', `/api/friends/${id}`);
export const inviteFriend = (id: string, code: string) => send('POST', `/api/friends/${id}/invite`, { code });
export const dismissInvite = (id: string) => send('DELETE', `/api/friends/invites/${id}`);

export const searchPlaces = (q: string, near?: LatLng | null) =>
  call<PlaceHit[]>(`/api/places/search?q=${encodeURIComponent(q)}${near ? `&lat=${near.la}&lon=${near.lo}` : ''}`);

export const resolveLink = (url: string) => call<ParsedPlace>(`/api/places/resolve?url=${encodeURIComponent(url)}`);

export const fetchRoute = (points: LatLng[]) =>
  call<RouteResult>(`/api/route?coords=${points.map((p) => `${p.lo},${p.la}`).join(';')}`);
