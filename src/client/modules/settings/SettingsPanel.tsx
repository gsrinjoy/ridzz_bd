import { useEffect, useState } from 'preact/hooks';
import { endRide, leaveRide, setMeters, signOut } from '../../app/session';
import { account, canControl, isAndroidApp, mapProblem, mapProvider, nearbyAllowed, nearbyPeers, meter, phase, prefs, rideMode, setPrefs, voice } from '../../app/store';
import { Moon } from '../../ui/icons';
import { changePassword, updateProfile } from '../ride/api';
import { setAccount } from '../../app/store';

function AccountSection() {
  const a = account.value;
  const [name, setName] = useState(a?.name ?? '');
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [message, setMessage] = useState('');
  if (!a) return null;

  async function saveName() {
    try {
      await updateProfile(name.trim(), (a as NonNullable<typeof a>).color);
      setAccount({ ...(a as NonNullable<typeof a>), name: name.trim() });
      setMessage('Name saved. It applies from your next ride.');
    } catch (e) {
      setMessage(e instanceof Error ? e.message : 'Could not save');
    }
  }

  async function savePassword() {
    try {
      setAccount(await changePassword(current, next));
      setCurrent('');
      setNext('');
      setMessage('Password changed. Other devices are signed out.');
    } catch (e) {
      setMessage(e instanceof Error ? e.message : 'Could not change it');
    }
  }

  return (
    <details class="account">
      <summary>Account</summary>
      <div class="setting">
        <label class="label" for="profile-name">Your name</label>
        <input id="profile-name" class="field" value={name} maxLength={24} onInput={(e) => setName(e.currentTarget.value)} />
        <button class="btn block" disabled={!name.trim() || name === a.name} onClick={() => void saveName()}>Save name</button>
      </div>
      <div class="setting">
        <span class="label">Change password</span>
        <input class="field" type="password" autoComplete="current-password" placeholder="Current password" aria-label="Current password" value={current} onInput={(e) => setCurrent(e.currentTarget.value)} />
        <input class="field" type="password" autoComplete="new-password" placeholder="New password, 8 or more characters" aria-label="New password" value={next} onInput={(e) => setNext(e.currentTarget.value)} />
        <button class="btn block" disabled={!current || next.length < 8} onClick={() => void savePassword()}>Change password</button>
      </div>
      {message && <span class="note" role="status">{message}</span>}
      <button class="btn block" onClick={() => void signOut()}>Sign out</button>
    </details>
  );
}

export function SettingsPanel() {
  useEffect(() => {
    setMeters(true);
    return () => setMeters(false);
  }, []);

  const p = prefs.value;
  const m = meter.value;
  const level = Math.max(0, Math.min(100, ((m.level + 70) / 60) * 100));
  const wind = Math.round(m.wind * 100);

  return (
    <>
      <button class="btn block" onClick={() => (rideMode.value = true)}><Moon /> Ride mode (saves battery)</button>

      <div class="setting">
        <span class="label">Mic after noise removal</span>
        <div class="meter"><i style={{ width: `${level}%` }} /></div>
        <span class="note num">Wind {wind}%{voice.value.status === 'off' ? ' · start voice to test' : ''}</span>
      </div>

      <div class="setting">
        <span class="label">Noise filter</span>
        <div class="seg" role="group" aria-label="Noise filter">
          {(['light', 'balanced', 'strong'] as const).map((f) => (
            <button key={f} aria-pressed={p.noiseFilter === f} onClick={() => setPrefs({ noiseFilter: f })}>{f[0]?.toUpperCase() + f.slice(1)}</button>
          ))}
        </div>
        <span class="note">If friends say you sound robotic, go lighter. If they hear wind, go stronger.</span>
      </div>

      <div class="setting">
        <label class="label" for="sens">Auto-talk sensitivity</label>
        <input id="sens" type="range" min="0" max="1" step="0.05" value={p.sensitivity} onInput={(e) => setPrefs({ sensitivity: Number(e.currentTarget.value) })} />
        <span class="note">If words get cut, raise this. If wind opens the mic, lower it.</span>
      </div>

      <label class="setting-row">
        <span>Open mic (always on air)</span>
        <input type="checkbox" checked={p.talkMode === 'open'} onChange={(e) => setPrefs({ talkMode: e.currentTarget.checked ? 'open' : 'vox' })} />
      </label>
      <label class="setting-row">
        <span>Battery saver (slower map updates)</span>
        <input type="checkbox" checked={p.batterySaver} onChange={(e) => setPrefs({ batterySaver: e.currentTarget.checked })} />
      </label>
      <label class="setting-row">
        <span>Speak alerts aloud</span>
        <input type="checkbox" checked={p.spokenAlerts} onChange={(e) => setPrefs({ spokenAlerts: e.currentTarget.checked })} />
      </label>

      {mapProvider.value && <span class="note">Map: {mapProvider.value === 'mappls' ? 'Mappls' : 'backup map'}</span>}
      {mapProvider.value === 'backup' && mapProblem.value && <span class="note map-problem">{mapProblem.value}</span>}

      {isAndroidApp() ? (
        <>
          <label class="setting-row">
            <span>Nearby link when the internet drops</span>
            <input type="checkbox" checked={p.nearbyMode === 'auto'} onChange={(e) => setPrefs({ nearbyMode: e.currentTarget.checked ? 'auto' : 'off' })} />
          </label>
          <span class="note">
            {nearbyAllowed.value === false
              ? 'Nearby devices permission is off, so this cannot work. Turn it on in Android settings.'
              : nearbyPeers.value !== null
                ? `Nearby link is on: ${nearbyPeers.value} in range.`
                : 'Starts by itself when the internet is lost, and stops when it returns.'}
          </span>
        </>
      ) : (
        <span class="note">Nearby link (no internet) works in the Android app only. Browsers cannot use it, on any phone.</span>
      )}
      <label class="setting-row">
        <span>Call sounds (join, leave, reconnect)</span>
        <input type="checkbox" checked={p.callSounds} onChange={(e) => setPrefs({ callSounds: e.currentTarget.checked })} />
      </label>

      <AccountSection />

      {phase.value === 'riding' && canControl.value && (
        <button class="btn danger block" onClick={() => { if (confirm('End the ride for everyone and save the stats?')) endRide(); }}>End ride for everyone</button>
      )}
      <button class="btn danger block" onClick={() => leaveRide()}>Leave ride</button>
    </>
  );
}
