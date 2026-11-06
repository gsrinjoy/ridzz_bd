import type { LatLng } from '../../../shared/geo';
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
}

export interface MapEvents {
  onRiderTap(id: string): void;
  onStopTap(id: string): void;
  onLongPress(at: LatLng): void;
  onReady(): void;
}

/** Everything the app asks of a map. A provider implements this and nothing else. */
export interface MapEngine {
  readonly provider: 'mappls' | 'backup';
  setRiders(riders: RiderPin[]): void;
  setStops(stops: StopPin[]): void;
  setRoute(line: LatLng[]): void;
  /** The dashed line from this rider to the selected one. */
  setLink(line: LatLng[]): void;
  fit(points: LatLng[]): void;
  center(at: LatLng, zoom?: number): void;
  destroy(): void;
}

export const riderPinClass = (r: RiderPin) =>
  `rider-pin${r.isMe ? ' me' : ''}${r.online ? '' : ' off'}${r.talking ? ' talking' : ''}`;

export const riderLabel = (r: RiderPin) => initial(r.name);

export const DEFAULT_VIEW = { center: { la: 21.5, lo: 78.9 } satisfies LatLng, zoom: 5 };
export const LONG_PRESS_MS = 550;
