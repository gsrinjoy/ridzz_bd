import type { BudgetView } from './budgets';

/** Wire format between client and RideRoom. Keys are short because location messages dominate traffic. */

export type StopKind = 'start' | 'fuel' | 'food' | 'rest' | 'view' | 'regroup' | 'finish';
export type AlertKind = 'fuel' | 'stop' | 'regroup' | 'hazard' | 'sos';

export interface Position {
  la: number;
  lo: number;
  /** km/h */
  sp: number;
  /** degrees from north, -1 when unknown */
  hd: number;
  /** epoch ms */
  ts: number;
}

export interface VoicePublication {
  sessionId: string;
  trackName: string;
}

export interface Rider {
  id: string;
  name: string;
  color: string;
  online: boolean;
  talking: boolean;
  lastSeen: number;
  pos?: Position;
  voice?: VoicePublication;
}

export interface Stop {
  id: string;
  name: string;
  la: number;
  lo: number;
  kind: StopKind;
  addedBy: string;
}

/** planning: being prepared. riding: recording, for everyone at once. finished: saved. */
export type RidePhase = 'planning' | 'riding' | 'finished';

export interface RideInfo {
  code: string;
  name: string;
  phase: RidePhase;
  /** The rider who controls starting and ending. */
  host: string;
  /** When the group meets, epoch ms. */
  startsAt?: number;
  startedAt?: number;
  endedAt?: number;
}

export type ClientMessage =
  | ({ t: 'loc' } & Position)
  | { t: 'talk'; on: boolean }
  | { t: 'voice'; pub: VoicePublication | null }
  | { t: 'rtc'; to: string; data: unknown }
  | { t: 'alert'; kind: AlertKind }
  | { t: 'ride.update'; name?: string; startsAt?: number | null }
  | { t: 'ride.start' }
  | { t: 'ride.finish' }
  | { t: 'stop.add'; stop: Omit<Stop, 'id' | 'addedBy'> }
  | { t: 'stop.remove'; id: string }
  | { t: 'stop.order'; ids: string[] };

/** One rider's position in a batch: id plus the Position fields. */
export type LocTuple = [id: string, la: number, lo: number, sp: number, hd: number, ts: number];

export type ServerMessage =
  | { t: 'state'; ride: RideInfo; you: string; riders: Rider[]; stops: Stop[] }
  | { t: 'rider'; rider: Rider }
  | { t: 'locs'; l: LocTuple[] }
  | { t: 'talk'; id: string; on: boolean }
  | { t: 'stops'; stops: Stop[] }
  | { t: 'ride'; ride: RideInfo }
  | { t: 'rtc'; from: string; data: unknown }
  | { t: 'alert'; id: string; kind: AlertKind; pos?: Position; at: number }
  | { t: 'left'; id: string }
  | { t: 'ended' }
  | { t: 'kicked' };

export interface JoinResponse {
  code: string;
  riderId: string;
  token: string;
}

/** A signed-in person. The token is a revocable session, not a permanent key. */
export interface Account {
  userId: string;
  token: string;
  name: string;
  color: string;
  friendCode: string;
  /** The app is private: nothing works until the owner approves the account. */
  approved: boolean;
}

/** Returned once, at sign-up or recovery. The code is never stored in readable form. */
export interface Registered {
  account: Account;
  recoveryCode: string;
}

export interface FriendInfo {
  id: string;
  name: string;
  color: string;
  friendCode: string;
}

export interface FriendRequest extends FriendInfo {
  requestId: string;
}

export interface RideInvite {
  inviteId: string;
  code: string;
  from: string;
}

export interface FriendsView {
  friends: FriendInfo[];
  incoming: FriendRequest[];
  outgoing: FriendRequest[];
  invites: RideInvite[];
}

export interface AdminUser extends FriendInfo {
  email: string;
  createdAt: number;
  lastSeen: number;
  blocked: boolean;
  approved: boolean;
  friends: number;
  ridesLogged: number;
}

export interface AdminRider {
  id: string;
  name: string;
  color: string;
  online: boolean;
  lastSeen: number;
  inCall: boolean;
  pos?: Position;
}

export interface AdminRide {
  code: string;
  name: string;
  phase: RidePhase;
  owner: string;
  createdAt: number;
  lastActive: number;
  riders: AdminRider[];
  stops: number;
}

export interface AdminOverview {
  users: number;
  pendingUsers: number;
  blockedUsers: number;
  friendships: number;
  rides: number;
  liveRides: number;
  ridersOnline: number;
  services: { voiceRelay: boolean; turn: boolean; mappls: boolean };
  budgets: BudgetView[];
}

export type VoiceConfig =
  | { mode: 'sfu'; iceServers: RTCIceServerLike[] }
  | { mode: 'mesh'; iceServers: RTCIceServerLike[] };

export interface RTCIceServerLike {
  urls: string | string[];
  username?: string;
  credential?: string;
}

export interface AppConfig {
  mapplsKey: string | null;
}

export interface PlaceHit {
  name: string;
  detail: string;
  la: number;
  lo: number;
}

export interface RouteResult {
  distanceM: number;
  durationS: number;
  /** One per gap between consecutive stops. */
  legs: { distanceM: number; durationS: number }[];
  /** [lon, lat] pairs */
  line: [number, number][];
}

export const MAX_RIDERS = 10;
export const RIDER_COLORS = ['#FF6A1A', '#2BD9C5', '#F5D90A', '#FF4D8D', '#7C8CFF', '#5BE37D', '#FF9F43', '#3EC7FF', '#E879F9', '#C9D1D9'];
