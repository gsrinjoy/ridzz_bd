import { effect } from '@preact/signals';
import { useEffect, useRef } from 'preact/hooks';
import type { LatLng } from '../../../shared/geo';
import { droppedPin, mapProblem, mapProvider, mapReady, myPosition, nextStop, phase, reachedStops, riders, route, selectedRiderId, selectedStopId, session, stops } from '../../app/store';
import { fetchConfig } from '../ride/api';
import type { MapEngine, MapEvents, RiderPin } from './engine';
import { createMapplsEngine, loadMapplsSdk } from './mapplsEngine';

const CONTAINER_ID = 'ride-map';
/** How often the map reframes the group while riding. Slow on purpose: each move costs GPU power. */
const FOLLOW_EVERY_MS = 15_000;
/** How long a rider's own panning is respected before the map follows again. */
const FOLLOW_PAUSE_MS = 30_000;

export interface MapHandle {
  fitAll(): void;
  centerOnMe(): void;
}

/** Mappls when there is a key and it loads. Anything else falls through to the backup so the map never stays blank. */
async function openEngine(container: HTMLElement, events: MapEvents): Promise<MapEngine> {
  const start = myPosition.value;
  try {
    const { mapplsKey } = await fetchConfig();
    mapProblem.value = mapplsKey ? null : 'No Mappls key is set on the server.';
    if (mapplsKey) return await createMapplsEngine(await loadMapplsSdk(mapplsKey), CONTAINER_ID, start, events);
  } catch (e) {
    console.warn('Mappls unavailable, using the backup map', e);
    mapProblem.value = e instanceof Error ? e.message : String(e);
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

/** While riding, what matters is the group and where it is heading next. */
function followPoints(): LatLng[] {
  const next = nextStop.value;
  return [...riderPins().filter((r) => r.online).map((r) => r.pos), ...(next ? [next] : [])];
}

export default function RideMap({ handle }: { handle: { current: MapHandle | null } }) {
  const container = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let engine: MapEngine | undefined;
    let cancelled = false;
    let disposers: (() => void)[] = [];
    let fitted = false;
    let planKey = '';
    let lastFollow = 0;
    let pausedUntil = 0;
    mapReady.value = false;

    void openEngine(container.current as HTMLDivElement, {
      onRiderTap: (id) => (selectedRiderId.value = id === session.value?.riderId ? null : id),
      onStopTap: (id) => (selectedStopId.value = id),
      onLongPress: (at) => (droppedPin.value = at),
      onReady: () => (mapReady.value = true),
      onUserPan: () => (pausedUntil = Date.now() + FOLLOW_PAUSE_MS),
    }).then((e) => {
      if (cancelled) return e.destroy();
      engine = e;
      mapProvider.value = e.provider;
      handle.current = {
        fitAll: () => {
          pausedUntil = 0;
          e.fit(phase.peek() === 'riding' ? followPoints() : allPoints());
        },
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
          const now = Date.now();
          if (phase.value === 'riding' && now > pausedUntil && now - lastFollow > FOLLOW_EVERY_MS) {
            lastFollow = now;
            e.fit(followPoints());
          }
        }),
        effect(() => {
          const selected = selectedStopId.value;
          const reached = reachedStops.value;
          e.setStops(stops.value.map((s, i) => ({ ...s, index: i + 1, selected: s.id === selected, reached: reached.includes(s.id) })));
        }),
        effect(() => {
          // The road route when known; otherwise straight lines still show the order of the plan.
          const line = route.value?.line.map(([lo, la]) => ({ la, lo }));
          e.setRoute(line ?? stops.value, !!line);
        }),
        effect(() => e.setDropped(droppedPin.value)),
        effect(() => {
          // Editing a plan shows the whole new plan, as long as nobody is riding it.
          const list = stops.value;
          const line = route.value?.line.map(([lo, la]) => ({ la, lo })) ?? [];
          const key = `${list.map((s) => s.id).join()}|${route.value?.distanceM ?? ''}`;
          if (key === planKey) return;
          planKey = key;
          if (list.length && phase.peek() !== 'riding') {
            fitted = true;
            e.fit([...list, ...line]);
          }
        }),
        effect(() => {
          const id = selectedStopId.value;
          const stop = stops.peek().find((s) => s.id === id);
          if (stop) e.center(stop, 14);
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
