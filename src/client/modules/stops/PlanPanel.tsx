import { useEffect, useRef, useState } from 'preact/hooks';
import { distanceM, formatDistance, type LatLng } from '../../../shared/geo';
import { directionsUrl, extractLink, googleSearchUrl, isShortMapsLink, parseMapsLink, routeUrl } from '../../../shared/mapsLink';
import type { ClientMessage, PlaceHit, Stop, StopKind } from '../../../shared/protocol';
import { send } from '../../app/session';
import { droppedPin, isAndroidApp, isIos, link, myPosition, pendingShare, reachedStops, ride, route, selectedStopId, stops } from '../../app/store';
import { ArrowDown, ArrowUp, Check, Grip, Navigate, Trash } from '../../ui/icons';
import { resolveLink, searchPlaces } from '../ride/api';
import { moved, slide } from './reorder';
import { useDragOrder } from './useDragOrder';

const KINDS: { kind: StopKind; label: string }[] = [
  { kind: 'start', label: 'Start' },
  { kind: 'fuel', label: 'Fuel' },
  { kind: 'food', label: 'Food' },
  { kind: 'rest', label: 'Rest' },
  { kind: 'view', label: 'Viewpoint' },
  { kind: 'regroup', label: 'Regroup' },
  { kind: 'finish', label: 'Finish' },
];

const kindLabel = (kind: StopKind) => KINDS.find((k) => k.kind === kind)?.label ?? 'Stop';
const looksLikeLink = (t: string) => !!extractLink(t) || !!parseMapsLink(t);

const hoursMinutes = (s: number) => {
  const h = Math.floor(s / 3600);
  const m = Math.round((s % 3600) / 60);
  return h ? `${h}h ${m}m` : `${m} min`;
};

/** datetime-local works in local time, while the ride stores epoch ms. */
function toLocalInput(ms?: number): string {
  if (!ms) return '';
  const d = new Date(ms);
  return new Date(ms - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
}

const NAME_SAVE_MS = 700;

function RideDetails() {
  const info = ride.value;
  const [name, setName] = useState(info?.name ?? '');
  const typing = useRef(false);
  const saving = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  // Someone else renaming the ride must not overwrite what this rider is typing.
  useEffect(() => {
    if (!typing.current) setName(info?.name ?? '');
  }, [info?.name]);

  function edit(value: string) {
    setName(value);
    typing.current = true;
    clearTimeout(saving.current);
    // Saved as they type: on a phone, leaving a field does not reliably fire blur.
    saving.current = setTimeout(() => {
      typing.current = false;
      if (value.trim()) send({ t: 'ride.update', name: value });
    }, NAME_SAVE_MS);
  }

  return (
    <div class="plan-head">
      <input
        class="field plan-name"
        value={name}
        maxLength={40}
        aria-label="Ride name"
        placeholder="Name this ride"
        onInput={(e) => edit(e.currentTarget.value)}
      />
      <div class="plan-when">
        <label class="label" for="meet">Meet</label>
        <input
          id="meet"
          class="field"
          type="datetime-local"
          value={toLocalInput(info?.startsAt)}
          onChange={(e) => {
            const v = e.currentTarget.value;
            send({ t: 'ride.update', startsAt: v ? new Date(v).getTime() : null });
          }}
        />
      </div>
    </div>
  );
}

function Summary() {
  const r = route.value;
  const count = stops.value.length;
  if (count < 2) return null;
  return (
    <div class="plan-sum">
      <div><span class="label">Total</span><b class="num">{r ? formatDistance(r.distanceM) : '…'}</b></div>
      <div><span class="label">Riding</span><b class="num">{r ? hoursMinutes(r.durationS) : '…'}</b></div>
      <div><span class="label">Stops</span><b class="num">{count}</b></div>
    </div>
  );
}

/** Shown at once, so a dropped row never jumps back while the server answers. Offline nothing is saved, so nothing moves. */
function changeStops(next: Stop[], msg: ClientMessage) {
  if (link.peek() === 'live') stops.value = next;
  send(msg);
}

function moveStop(id: string, to: number) {
  const list = stops.value;
  const from = list.findIndex((s) => s.id === id);
  if (from < 0 || from === to) return;
  const next = moved(list, from, Math.min(to, list.length - 1));
  changeStops(next, { t: 'stop.order', ids: next.map((s) => s.id) });
}

/** Removing changes the plan for everyone, so a stray tap in gloves only asks. */
const REMOVE_ARMED_MS = 3000;

interface StopItemProps {
  stop: Stop;
  index: number;
  total: number;
  lifted: boolean;
  shift: number;
  grip: Record<string, (e: PointerEvent) => void>;
}

function StopItem({ stop, index, total, lifted, shift, grip }: StopItemProps) {
  const open = selectedStopId.value === stop.id;
  const [armed, setArmed] = useState(false);
  const disarm = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const here = myPosition.value;
  const leg = index > 0 ? route.value?.legs[index - 1] : undefined;
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (open) ref.current?.scrollIntoView({ block: 'nearest' });
  }, [open]);

  useEffect(() => () => clearTimeout(disarm.current), []);

  function remove() {
    clearTimeout(disarm.current);
    if (!armed) {
      setArmed(true);
      disarm.current = setTimeout(() => setArmed(false), REMOVE_ARMED_MS);
      return;
    }
    if (open) selectedStopId.value = null;
    changeStops(stops.value.filter((s) => s.id !== stop.id), { t: 'stop.remove', id: stop.id });
  }

  return (
    <div ref={ref} class={`stop ${open ? 'open' : ''} ${lifted ? 'lifted' : ''}`} style={shift ? { transform: `translateY(${shift}px)` } : undefined}>
      <div class="stop-line">
      {total > 1 && <span class="stop-grip" role="img" aria-label={`Drag to reorder ${stop.name}`} {...grip}><Grip /></span>}
      <button class="stop-row" aria-expanded={open} onClick={() => (selectedStopId.value = open ? null : stop.id)}>
        <span class={`stop-index num ${reachedStops.value.includes(stop.id) ? 'reached' : ''}`}>{reachedStops.value.includes(stop.id) ? <Check /> : index + 1}</span>
        <span class="row-main">
          <div class="row-title">{stop.name}</div>
          <div class="row-sub">{kindLabel(stop.kind)}{here ? ` · ${formatDistance(distanceM(here, stop))} from you` : ''}</div>
        </span>
        {leg && <span class="leg num">+{formatDistance(leg.distanceM)}</span>}
      </button>
      <button class={`stop-remove ${armed ? 'armed' : ''}`} aria-label={armed ? `Tap again to remove ${stop.name}` : `Remove ${stop.name}`} onClick={remove}>
        {armed ? 'Remove?' : <Trash />}
      </button>
      </div>
      {open && (
        <div class="stop-tools">
          <a class="btn primary block" href={directionsUrl(stop)} target="_blank" rel="noopener">
            <Navigate /> Get directions
          </a>
          {isIos() && <span class="note">Voice pauses while you are out of this app.</span>}
          <div class="stop-moves">
            <button class="icon-btn" aria-label={`Move ${stop.name} earlier`} disabled={index === 0} onClick={() => moveStop(stop.id, index - 1)}><ArrowUp /></button>
            <button class="icon-btn" aria-label={`Move ${stop.name} later`} disabled={index === total - 1} onClick={() => moveStop(stop.id, index + 1)}><ArrowDown /></button>
          </div>
        </div>
      )}
    </div>
  );
}

function Timeline({ list }: { list: Stop[] }) {
  const { drag, grip } = useDragOrder(moveStop);
  return (
    <div class={`timeline ${drag ? 'dragging' : ''}`}>
      {list.map((s, i) => (
        <StopItem
          key={s.id}
          stop={s}
          index={i}
          total={list.length}
          lifted={drag?.from === i}
          shift={!drag ? 0 : drag.from === i ? drag.dy : slide(i, drag.from, drag.to, drag.height)}
          grip={grip(s.id, i)}
        />
      ))}
    </div>
  );
}

export function PlanPanel() {
  const [query, setQuery] = useState(pendingShare.value ?? '');
  const [hits, setHits] = useState<PlaceHit[]>([]);
  const [kind, setKind] = useState<StopKind>(stops.value.length ? 'fuel' : 'start');
  const [message, setMessage] = useState('');
  const seq = useRef(0);
  const here = myPosition.value;
  const pin = droppedPin.value;

  function add(name: string, at: LatLng) {
    send({ t: 'stop.add', stop: { name, la: at.la, lo: at.lo, kind } });
    setQuery('');
    setHits([]);
    setMessage('');
    pendingShare.value = null;
    droppedPin.value = null;
    if (kind === 'start') setKind('fuel');
  }

  async function addFromLink(text: string) {
    setMessage('Reading link…');
    const first = text.split('\n')[0]?.trim();
    const link = extractLink(text);
    try {
      const direct = parseMapsLink(text);
      const place = link && (isShortMapsLink(link) || direct?.la === undefined) ? await resolveLink(link) : direct;
      if (place?.la === undefined || place.lo === undefined) throw new Error('No location found in that link');
      const fallback = first && !first.startsWith('http') ? first : 'Shared place';
      add(place.name ?? fallback, { la: place.la, lo: place.lo });
    } catch (e) {
      setMessage(e instanceof Error ? e.message : 'Could not read that link');
    }
  }

  useEffect(() => {
    const q = query.trim();
    const id = ++seq.current;
    if (q.length < 3 || looksLikeLink(q)) {
      setHits([]);
      return;
    }
    setMessage('Searching…');
    const timer = setTimeout(() => {
      searchPlaces(q, here)
        .then((found) => {
          if (id !== seq.current) return;
          setHits(found);
          setMessage(found.length ? '' : 'No places found. Try another name, or long-press the map.');
        })
        .catch(() => setMessage('Search is unavailable. Long-press the map instead.'));
    }, 500);
    return () => clearTimeout(timer);
  }, [query]);

  useEffect(() => {
    if (pendingShare.value) void addFromLink(pendingShare.value);
  }, []);

  const list = stops.value;
  const whole = list.length > 1 ? routeUrl(list) : undefined;
  const first = list[0];

  return (
    <>
      <RideDetails />
      <Summary />

      <div class="kinds" role="group" aria-label="Type of stop to add">
        {KINDS.map((k) => (
          <button key={k.kind} class="kind" aria-pressed={k.kind === kind} onClick={() => setKind(k.kind)}>{k.label}</button>
        ))}
      </div>

      {pin ? (
        <div class="detail">
          <span class="note">Add a {kindLabel(kind).toLowerCase()} stop at the pin?</span>
          <button class="btn primary block" onClick={() => add(kindLabel(kind), pin)}>Add stop here</button>
          <button class="btn block" onClick={() => (droppedPin.value = null)}>Cancel</button>
        </div>
      ) : (
        <input
          class="field"
          type="search"
          value={query}
          placeholder="Search places, or paste a Google Maps link"
          aria-label="Search for a stop"
          onInput={(e) => {
            const v = e.currentTarget.value;
            setQuery(v);
            setMessage('');
            if (looksLikeLink(v)) void addFromLink(v);
          }}
        />
      )}
      {message && <span class="note" role="status">{message}</span>}

      {query.trim().length >= 2 && !looksLikeLink(query) && !pin && (
        <a class="btn block" href={googleSearchUrl(query.trim(), here)} target="_blank" rel="noopener">
          <Navigate /> Search “{query.trim().slice(0, 24)}” on Google Maps
        </a>
      )}
      {query.trim().length >= 2 && !looksLikeLink(query) && !pin && (
        <span class="note">Found it there? {isAndroidApp() ? 'Tap Share, then choose Slipstream.' : 'Tap Share, Copy link, and paste it in the box above.'}</span>
      )}

      {hits.length > 0 && (
        <div class="hits">
          {hits.map((h) => (
            <button key={`${h.la},${h.lo}`} class="row" onClick={() => add(h.name, h)}>
              <span class="row-main">
                <div class="row-title">{h.name}</div>
                <div class="row-sub">{h.detail}</div>
              </span>
              <span class="row-end num">{here ? formatDistance(distanceM(here, h)) : ''}</span>
            </button>
          ))}
        </div>
      )}

      {list.length > 0 && <Timeline list={list} />}

      {!list.length && !hits.length && !pin && (
        <p class="note">Search for where the ride starts, then add fuel, food and the finish. Long-pressing the map works too. Everyone on the ride sees the plan the moment you change it.</p>
      )}

      {first && (
        <a class="btn primary block" href={whole ?? directionsUrl(first)} target="_blank" rel="noopener">
          <Navigate /> {whole ? 'Start navigation' : `Navigate to ${first.name}`}
        </a>
      )}
    </>
  );
}
