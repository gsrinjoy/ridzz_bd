import { useEffect } from 'preact/hooks';
import { leaveRide, setMeters } from '../../app/session';
import { mapProvider, meter, prefs, rideMode, setPrefs, voice } from '../../app/store';
import { Moon } from '../../ui/icons';

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

      {mapProvider.value && <span class="note">Map: {mapProvider.value === 'mappls' ? 'Mappls' : 'backup map (Mappls key not set or unavailable)'}</span>}

      <label class="setting-row">
        <span>Call sounds (join, leave, reconnect)</span>
        <input type="checkbox" checked={p.callSounds} onChange={(e) => setPrefs({ callSounds: e.currentTarget.checked })} />
      </label>

      <button class="btn danger block" onClick={() => leaveRide()}>Leave ride</button>
    </>
  );
}
