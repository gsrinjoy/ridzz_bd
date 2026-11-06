import { useRef, useState } from 'preact/hooks';
import type { AlertKind } from '../../../shared/protocol';
import { sendAlert } from '../../app/session';

const QUICK: { kind: AlertKind; label: string }[] = [
  { kind: 'fuel', label: 'Need fuel' },
  { kind: 'stop', label: 'Need a stop' },
  { kind: 'regroup', label: 'Regroup' },
  { kind: 'hazard', label: 'Hazard ahead' },
];

const SOS_HOLD_MS = 1500;

export function AlertsPanel() {
  const [down, setDown] = useState(false);
  const [sent, setSent] = useState('');
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  function quick(kind: AlertKind, label: string) {
    sendAlert(kind);
    setSent(`Sent: ${label}`);
  }

  const release = () => {
    clearTimeout(timer.current);
    setDown(false);
  };

  return (
    <>
      <div class="alerts-grid">
        {QUICK.map((q) => (
          <button key={q.kind} class="alert-btn" onClick={() => quick(q.kind, q.label)}>{q.label}</button>
        ))}
      </div>
      {/* Held rather than tapped, so a pocket press cannot raise it. */}
      <button
        class={`sos ${down ? 'down' : ''}`}
        onPointerDown={() => {
          setDown(true);
          timer.current = setTimeout(() => {
            release();
            quick('sos', 'SOS with your location');
          }, SOS_HOLD_MS);
        }}
        onPointerUp={release}
        onPointerLeave={release}
        onPointerCancel={release}
      >
        <i />
        <span>Hold for SOS</span>
      </button>
      <span class="note" role="status">{sent || 'Alerts play a tone and are spoken to the group.'}</span>
    </>
  );
}
