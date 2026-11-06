import { registerPlugin } from '@capacitor/core';
import type { Position } from '../../../shared/protocol';
import type { AudioRoute } from '../../app/session';

/** The Android side of a ride. Only present inside the APK; see RideShellPlugin.java. */
export interface RideShellPlugin {
  start(): Promise<{ headset: string }>;
  stop(): Promise<void>;
  requestBatteryExemption(): Promise<{ exempt: boolean }>;
  listRoutes(): Promise<{ routes: AudioRoute[] }>;
  setRoute(options: { id: string }): Promise<void>;
  addListener(event: 'location', handler: (pos: Position) => void): Promise<{ remove(): Promise<void> }>;
}

export const RideShell = registerPlugin<RideShellPlugin>('RideShell');
