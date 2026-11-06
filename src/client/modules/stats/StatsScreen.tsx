import { useEffect, useMemo, useState } from 'preact/hooks';
import { formatDistance } from '../../../shared/geo';
import { avgMovingKmh, avgOverallKmh, INTERVAL_S, SPEED_BANDS, type RideLog, type RideSummary, type TrackPoint } from '../../../shared/stats';
import { fetchRideLog, fetchRideLogs } from '../ride/api';

/** One hue, dark to bright on the dark surface: speed is a magnitude, not a category. */
const RAMP = ['#945226', '#BE5B1B', '#EB6C17', '#FF9A55', '#FFD3B3'];
const RAMP_STOPS = [20, 40, 60, 80];

const speedColor = (kmh: number) => RAMP[RAMP_STOPS.filter((s) => kmh >= s).length] as string;

const duration = (s: number) => {
  const h = Math.floor(s / 3600);
  const m = Math.round((s % 3600) / 60);
  return h ? `${h} h ${m} min` : `${m} min`;
};

const clock = (seconds: number) => {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return `${h}:${String(m).padStart(2, '0')}`;
};

const niceDate = (date: string) => new Date(`${date}T12:00:00`).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });

const bandLabel = (i: number) => {
  const low = SPEED_BANDS[i] as number;
  const high = SPEED_BANDS[i + 1];
  return high === undefined ? `${low}+` : `${low}–${high}`;
};

function Tile({ label, value, unit }: { label: string; value: string; unit?: string }) {
  return (
    <div class="stat-card">
      <span class="label">{label}</span>
      <b class="num">{value}{unit && <small> {unit}</small>}</b>
    </div>
  );
}

/** Drawn as plain SVG: viewing a past ride loads no map SDK and no tiles. */
function SpeedMap({ track }: { track: TrackPoint[] }) {
  const segments = useMemo(() => {
    if (track.length < 2) return [];
    const las = track.map((p) => p[0]);
    const los = track.map((p) => p[1]);
    const [minLa, maxLa, minLo, maxLo] = [Math.min(...las), Math.max(...las), Math.min(...los), Math.max(...los)];
    // Longitude degrees shrink with latitude, so correct it or the route looks squashed.
    const squash = Math.cos(((minLa + maxLa) / 2 / 1e5) * (Math.PI / 180));
    const scale = 300 / Math.max((maxLo - minLo) * squash, maxLa - minLa, 1);
    const x = (lo: number) => 10 + (lo - minLo) * squash * scale;
    const y = (la: number) => 310 - (la - minLa) * scale;
    return track.slice(1).map((p, i) => {
      const prev = track[i] as TrackPoint;
      return { x1: x(prev[1]), y1: y(prev[0]), x2: x(p[1]), y2: y(p[0]), color: speedColor(p[2]) };
    });
  }, [track]);

  if (!segments.length) return <p class="note">Not enough GPS points to draw this ride.</p>;
  return (
    <figure class="chart">
      <figcaption class="label">Speed map</figcaption>
      <svg class="speed-map" viewBox="0 0 320 320" role="img" aria-label="Route of the ride, coloured by speed">
        {segments.map((s, i) => <line key={i} x1={s.x1} y1={s.y1} x2={s.x2} y2={s.y2} stroke={s.color} stroke-width="3" stroke-linecap="round" />)}
      </svg>
      <div class="ramp" aria-hidden="true">
        {RAMP.map((c, i) => <span key={c}><i style={{ background: c }} />{i === 0 ? `<${RAMP_STOPS[0]}` : i === RAMP.length - 1 ? `${RAMP_STOPS[i - 1]}+` : `${RAMP_STOPS[i - 1]}–${RAMP_STOPS[i]}`}</span>)}
        <span class="note">km/h</span>
      </div>
    </figure>
  );
}

function SpeedOverTime({ log }: { log: RideLog }) {
  const [hover, setHover] = useState<number | null>(null);
  const speeds = log.intervals.map(([m, s]) => (s > 0 ? (m / s) * 3.6 : 0));
  if (!speeds.length) return null;
  const top = Math.max(40, Math.ceil(Math.max(...speeds) / 20) * 20);
  const W = 320;
  const H = 150;
  const PAD_L = 28;
  const PAD_B = 18;
  const plotH = H - PAD_B - 6;
  const step = (W - PAD_L) / speeds.length;
  const barW = Math.max(2, step - 2);
  const y = (v: number) => 6 + plotH - (v / top) * plotH;
  const shown = hover === null ? null : speeds[hover];
  return (
    <figure class="chart">
      <figcaption class="label">Average speed every {INTERVAL_S / 60} minutes</figcaption>
      <div class="chart-readout note num" role="status">
        {shown != null && hover !== null ? `${clock(hover * INTERVAL_S)} into the ride: ${Math.round(shown)} km/h` : 'Tap a bar for its value'}
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Average speed through the ride" onPointerLeave={() => setHover(null)}>
        {[0, top / 2, top].map((v) => (
          <g key={v}>
            <line x1={PAD_L} x2={W} y1={y(v)} y2={y(v)} class="grid" />
            <text x={PAD_L - 5} y={y(v) + 4} class="tick" text-anchor="end">{v}</text>
          </g>
        ))}
        {speeds.map((v, i) => {
          const h = Math.max(1, y(0) - y(v));
          return (
            <g key={i} onPointerEnter={() => setHover(i)} onPointerDown={() => setHover(i)}>
              <rect x={PAD_L + i * step} y={6} width={step} height={plotH} fill="transparent" />
              <rect x={PAD_L + i * step + 1} y={y(v)} width={barW} height={h} rx={Math.min(4, barW / 2)} class={i === hover ? 'bar on' : 'bar'} />
            </g>
          );
        })}
        <text x={PAD_L} y={H - 4} class="tick">0:00</text>
        <text x={W} y={H - 4} class="tick" text-anchor="end">{clock(speeds.length * INTERVAL_S)}</text>
      </svg>
    </figure>
  );
}

function TimeInBands({ log }: { log: RideLog }) {
  const total = log.bands.reduce((a, b) => a + b, 0);
  if (!total) return null;
  const most = Math.max(...log.bands);
  return (
    <figure class="chart">
      <figcaption class="label">Time at each speed (km/h)</figcaption>
      <div class="bands">
        {log.bands.map((s, i) => (
          <div key={i} class="band">
            <span class="num">{bandLabel(i)}</span>
            <span class="band-track"><i style={{ width: `${(s / most) * 100}%` }} /></span>
            <span class="num">{duration(s)}</span>
          </div>
        ))}
      </div>
    </figure>
  );
}

function SpeedLog({ log }: { log: RideLog }) {
  return (
    <details class="speed-log">
      <summary>Full speed log</summary>
      <table>
        <thead><tr><th scope="col">Time</th><th scope="col">Avg speed</th><th scope="col">Distance</th></tr></thead>
        <tbody>
          {log.intervals.map(([m, s], i) => (
            <tr key={i} class="num">
              <td>{clock(i * INTERVAL_S)}</td>
              <td>{s > 0 ? `${Math.round((m / s) * 3.6)} km/h` : 'Stopped'}</td>
              <td>{formatDistance(m)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </details>
  );
}

export function Detail({ id, onBack, backLabel = 'All rides' }: { id: string; onBack: () => void; backLabel?: string }) {
  const [log, setLog] = useState<RideLog | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    fetchRideLog(id).then(setLog).catch((e: Error) => setError(e.message));
  }, [id]);
  return (
    <>
      <button class="btn" onClick={onBack}>{backLabel}</button>
      {error && <p class="error" role="alert">{error}</p>}
      {log && (
        <>
          <div>
            <h2 class="stats-title">{log.rideName}</h2>
            <span class="note">{niceDate(log.date)}</span>
          </div>
          <div class="stat-grid">
            <Tile label="Distance" value={(log.distanceM / 1000).toFixed(1)} unit="km" />
            <Tile label="Avg moving" value={String(Math.round(avgMovingKmh(log)))} unit="km/h" />
            <Tile label="Top speed" value={String(Math.round(log.topKmh))} unit="km/h" />
            <Tile label="Riding" value={duration(log.movingS)} />
            <Tile label="Stopped" value={duration(log.stoppedS)} />
            <Tile label="Avg overall" value={String(Math.round(avgOverallKmh(log)))} unit="km/h" />
          </div>
          {log.gapS > 60 && <span class="note">No GPS for {duration(log.gapS)}, so that stretch is estimated in a straight line.</span>}
          <SpeedMap track={log.track} />
          <SpeedOverTime log={log} />
          <TimeInBands log={log} />
          <SpeedLog log={log} />
        </>
      )}
    </>
  );
}

export function StatsScreen({ onClose }: { onClose: () => void }) {
  const [logs, setLogs] = useState<RideSummary[] | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    fetchRideLogs().then(setLogs).catch((e: Error) => setError(e.message));
  }, []);

  return (
    <main class="ride-stats">
      {open ? (
        <Detail id={open} onBack={() => setOpen(null)} />
      ) : (
        <>
          <header class="admin-top">
            <h2 class="stats-title">My rides</h2>
            <button class="btn" onClick={onClose}>Close</button>
          </header>
          {error && <p class="error" role="alert">{error}</p>}
          {logs?.length === 0 && <p class="note">Your rides appear here when you leave one.</p>}
          {logs?.map((l) => (
            <button key={l.id} class="row selected" onClick={() => setOpen(l.id)}>
              <span class="row-main">
                <div class="row-title">{l.rideName}</div>
                <div class="row-sub">{niceDate(l.date)} · {duration(l.movingS)}</div>
              </span>
              <span class="row-end num">{(l.distanceM / 1000).toFixed(1)} km<div class="row-sub">{Math.round(avgMovingKmh(l))} km/h</div></span>
            </button>
          ))}
        </>
      )}
    </main>
  );
}
