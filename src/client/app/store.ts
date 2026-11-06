import { computed, signal } from '@preact/signals';
import type { LatLng } from '../../shared/geo';
import type { Account, AlertKind, FriendsView, JoinResponse, Position, RideInfo, Rider, RouteResult, Stop } from '../../shared/protocol';
import type { NoiseFilter, TalkMode } from '../modules/voice/dsp/chain';

export type Session = JoinResponse;

const KEY = 'slipstream.session';
const ACCOUNT_KEY = 'slipstream.account';

function read<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function write(key: string, value: unknown): void {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Private mode: the session simply will not survive a reload.
  }
}

export const session = signal<Session | null>(read<Session | null>(KEY, null));
export function setSession(value: Session | null): void {
  session.value = value;
  write(KEY, value);
}

export const account = signal<Account | null>(read<Account | null>(ACCOUNT_KEY, null));
export function setAccount(value: Account | null): void {
  account.value = value;
  write(ACCOUNT_KEY, value);
}

export const friends = signal<FriendsView>({ friends: [], incoming: [], outgoing: [], invites: [] });
/** Shown on the home screen, for example when the owner ended the ride. */
export const notice = signal<string | null>(null);

export interface Preferences {
  talkMode: TalkMode;
  /** 0 picks up only clear speech, 1 opens on anything voiced. */
  sensitivity: number;
  noiseFilter: NoiseFilter;
  batterySaver: boolean;
  spokenAlerts: boolean;
  callSounds: boolean;
  /** Per-rider playback level, 0..1.5, by rider id. */
  volumes: Record<string, number>;
}

const PREFS = 'slipstream.prefs';
export const prefs = signal<Preferences>({
  talkMode: 'vox',
  sensitivity: 0.5,
  noiseFilter: 'balanced',
  batterySaver: false,
  spokenAlerts: true,
  callSounds: true,
  volumes: {},
  ...read<Partial<Preferences>>(PREFS, {}),
});
export function setPrefs(patch: Partial<Preferences>): void {
  prefs.value = { ...prefs.value, ...patch };
  write(PREFS, prefs.value);
}

export const ride = signal<RideInfo | null>(null);
export const riders = signal<Record<string, Rider>>({});
export const stops = signal<Stop[]>([]);
export const selectedRiderId = signal<string | null>(null);
export const selectedStopId = signal<string | null>(null);
/** A point picked on the map, waiting for the rider to confirm it as a stop. */
export const droppedPin = signal<LatLng | null>(null);
/** The road route through the plan's stops. Null until worked out, or when offline. */
export const route = signal<RouteResult | null>(null);
/** Opens the planner on arrival: just created a ride, or joined one with a plan. */
export const openPlanner = signal(false);

export type LinkState = 'connecting' | 'live' | 'retrying';
export const link = signal<LinkState>('connecting');

export type VoiceStatus = 'off' | 'starting' | 'live' | 'recovering' | 'blocked';
export const voice = signal<{ status: VoiceStatus; transport: 'sfu' | 'mesh' | null; peers: number; rttMs: number | null; startedAt: number | null }>({
  status: 'off',
  transport: null,
  peers: 0,
  rttMs: null,
  startedAt: null,
});

/** True while this rider's audio is on the air. */
export const transmitting = signal(false);
export const pttHeld = signal(false);
export const meter = signal({ level: -90, wind: 0, speech: 0 });

export const myPosition = signal<Position | null>(null);
export const locationError = signal<string | null>(null);

export const mapProvider = signal<'mappls' | 'backup' | null>(null);
export const mapReady = signal(false);
export const rideMode = signal(false);
export const incomingAlert = signal<{ id: string; name: string; kind: AlertKind; pos?: Position; at: number } | null>(null);
export const pendingShare = signal<string | null>(null);

export const me = computed(() => {
  const s = session.value;
  return s ? riders.value[s.riderId] : undefined;
});

export const otherRiders = computed(() => {
  const id = session.value?.riderId;
  return Object.values(riders.value).filter((r) => r.id !== id);
});

export const isAndroidApp = () => (window as { Capacitor?: { getPlatform?: () => string } }).Capacitor?.getPlatform?.() === 'android';
export const isIos = () => /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
