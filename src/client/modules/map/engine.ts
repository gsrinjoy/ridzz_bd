import type { LatLng } from '../../../shared/geo';
import type { StopKind } from '../../../shared/protocol';
import { initial } from '../../app/format';

export interface RiderPin {
  id: string;
  name: string;
  color: string;
  pos: LatLng;
  isMe: boolean;
  online: boolean;
  talking: boolean;
}

export interface StopPin extends LatLng {
  id: string;
  name: string;
  index: number;
  kind: StopKind;
  selected: boolean;
  reached: boolean;
}

export interface MapEvents {
  onRiderTap(id: string): void;
  onStopTap(id: string): void;
  onLongPress(at: LatLng): void;
  onReady(): void;
  /** The rider moved the map by hand, so following pauses. */
  onUserPan(): void;
}

/** Everything the app asks of a map. A provider implements this and nothing else. */
export interface MapEngine {
  readonly provider: 'mappls' | 'backup';
  setRiders(riders: RiderPin[]): void;
  setStops(stops: StopPin[]): void;
  /** `exact` is false for a straight-line sketch, drawn so it cannot be mistaken for the road. */
  setRoute(line: LatLng[], exact: boolean): void;
  /** The pin a long-press leaves, until it is added as a stop or cancelled. */
  setDropped(at: LatLng | null): void;
  /** The dashed line from this rider to the selected one. */
  setLink(line: LatLng[]): void;
  fit(points: LatLng[]): void;
  center(at: LatLng, zoom?: number): void;
  destroy(): void;
}

export const riderPinClass = (r: RiderPin) =>
  `rider-pin${r.isMe ? ' me' : ''}${r.online ? '' : ' off'}${r.talking ? ' talking' : ''}`;

export const riderLabel = (r: RiderPin) => initial(r.name);

export const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** A teardrop whose tip is the bottom centre, so the tip can sit exactly on the place. */
const PIN_SHAPE = '<svg viewBox="0 0 36 46" aria-hidden="true"><path d="M18 1C8.6 1 1 8.6 1 18c0 12.4 17 27 17 27s17-14.6 17-27C35 8.6 27.4 1 18 1z"/></svg>';

export function stopPinHtml(s: StopPin): string {
  const classes = ['stop-pin', `kind-${s.kind}`, s.selected ? 'selected' : '', s.reached ? 'reached' : ''].filter(Boolean).join(' ');
  return `<div class="${classes}" title="${escapeHtml(s.name)}">${PIN_SHAPE}<b class="num">${s.reached ? '✓' : s.index}</b><span class="stop-pin-name">${escapeHtml(s.name)}</span></div>`;
}

export const DROPPED_PIN_HTML = `<div class="stop-pin dropped">${PIN_SHAPE}<b>+</b></div>`;

export const DEFAULT_VIEW = { center: { la: 21.5, lo: 78.9 } satisfies LatLng, zoom: 5 };
export const LONG_PRESS_MS = 550;
