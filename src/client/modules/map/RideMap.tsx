import { effect } from '@preact/signals';
import { useEffect, useRef } from 'preact/hooks';
import type { LatLng } from '../../../shared/geo';
import { droppedPin, mapProvider, mapReady, myPosition, riders, route, selectedRiderId, selectedStopId, session, stops } from '../../app/store';
import { fetchConfig } from '../ride/api';
import type { MapEngine, MapEvents, RiderPin } from './engine';
import { createMapplsEngine, loadMapplsSdk } from './mapplsEngine';

const CONTAINER_ID = 'ride-map';

export interface MapHandle {
  fitAll(): void;
  centerOnMe(): void;
}

/** Mappls when there is a key and it loads. Anything else falls through to the backup so the map never stays blank. */
async function openEngine(container: HTMLElement, events: MapEvents): Promise<MapEngine> {
  const start = myPosition.value;
  try {
    const { mapplsKey } = await fetchConfig();
    if (mapplsKey) return await createMapplsEngine(await loadMapplsSdk(mapplsKey), CONTAINER_ID, start, events);
  } catch (e) {
    console.warn('Mappls unavailable, using the backup map', e);
    container.replaceChildren();
  }
  const { createBackupEngine } = await import('./backupEngine');
  return createBackupEngine(container, start, events);
}

function riderPins(): RiderPin[] {
  const selfId = session.value?.riderId;
  return Object.values(riders.value).flatMap((r) => {
    const isMe = r.id === selfId;
    const pos = isMe ? (myPosition.value ?? r.pos) : r.pos;
    return pos ? [{ id: r.id, name: r.name, color: r.color, online: r.online, talking: r.talking, isMe, pos }] : [];
  });
}

const allPoints = (): LatLng[] => [...riderPins().map((r) => r.pos), ...stops.value];

export default function RideMap({ handle }: { handle: { current: MapHandle | null } }) {
  const container = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let engine: MapEngine | undefined;
    let cancelled = false;
    let disposers: (() => void)[] = [];
    let fitted = false;
    mapReady.value = false;

    void openEngine(container.current as HTMLDivElement, {
      onRiderTap: (id) => (selectedRiderId.value = id === session.value?.riderId ? null : id),
      onStopTap: (id) => (selectedStopId.value = id),
      onLongPress: (at) => (droppedPin.value = at),
      onReady: () => (mapReady.value = true),
    }).then((e) => {
      if (cancelled) return e.destroy();
      engine = e;
      mapProvider.value = e.provider;
      handle.current = {
        fitAll: () => e.fit(allPoints()),
        centerOnMe: () => {
          const p = myPosition.value;
          if (p) e.center(p, 13);
        },
      };
      disposers = [
        effect(() => {
          const pins = riderPins();
          e.setRiders(pins);
          const me = pins.find((p) => p.isMe)?.pos;
          const other = pins.find((p) => p.id === selectedRiderId.value)?.pos;
          e.setLink(me && other ? [me, other] : []);
          if (!fitted && allPoints().length > 1) {
            fitted = true;
            e.fit(allPoints());
          }
        }),
        effect(() => {
          e.setStops(stops.value.map((s, i) => ({ ...s, index: i + 1 })));
        }),
        effect(() => {
          // The road route when known; otherwise straight lines still show the order of the plan.
          const line = route.value?.line.map(([lo, la]) => ({ la, lo }));
          e.setRoute(line ?? stops.value);
        }),
        effect(() => {
          const id = selectedRiderId.value;
          const pos = id ? riders.peek()[id]?.pos : undefined;
          if (pos) e.center(pos);
        }),
      ];
    });

    return () => {
      cancelled = true;
      disposers.forEach((d) => d());
      handle.current = null;
      engine?.destroy();
    };
  }, []);

  return <div ref={container} id={CONTAINER_ID} class="map" />;
}
