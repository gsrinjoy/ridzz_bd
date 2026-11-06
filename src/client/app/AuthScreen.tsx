import { useState } from 'preact/hooks';
import { RIDER_COLORS, type Account } from '../../shared/protocol';
import { login, recoverAccount, register } from '../modules/ride/api';
import { Copy, Logo } from '../ui/icons';
import { notice, setAccount } from './store';

type Mode = 'signin' | 'register' | 'recover';

const TITLES: Record<Mode, string> = {
  signin: 'Welcome back',
  register: 'Create your account',
  recover: 'Reset your password',
};

/** Shown once. It is the only way back in without a password, since no email is sent. */
function SaveRecovery({ code, onDone }: { code: string; onDone: () => void }) {
  const [copied, setCopied] = useState(false);
  return (
    <main class="home">
      <div class="home-card">
        <h2 class="stats-title">Save your recovery code</h2>
        <p class="note">If you forget your password, this is how you get back in. It is shown only this once, so keep it somewhere safe.</p>
        <div class="recovery-code">{code}</div>
        <button class="btn block" onClick={() => void navigator.clipboard.writeText(code).then(() => setCopied(true))}>
          <Copy /> {copied ? 'Copied' : 'Copy code'}
        </button>
        <button class="btn primary block" onClick={onDone}>I saved it</button>
      </div>
    </main>
  );
}

export function AuthScreen() {
  const [mode, setMode] = useState<Mode>('signin');
  const [name, setName] = useState('');
  const [color, setColor] = useState(RIDER_COLORS[0] as string);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState<{ account: Account; recoveryCode: string } | null>(null);

  if (saved) return <SaveRecovery code={saved.recoveryCode} onDone={() => setAccount(saved.account)} />;

  async function submit(e: Event) {
    e.preventDefault();
    setBusy(true);
    setError('');
    notice.value = null;
    try {
      if (mode === 'signin') setAccount(await login(email, password));
      if (mode === 'register') setSaved(await register(name, color, email, password));
      if (mode === 'recover') setSaved(await recoverAccount(email, code, password));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong');
    } finally {
      setBusy(false);
    }
  }

  const go = (next: Mode) => {
    setMode(next);
    setError('');
  };

  return (
    <main class="home">
      <form class="home-card auth-form" onSubmit={(e) => void submit(e)}>
        <div class="mark">
          <Logo />
          <h1>Slipstream</h1>
        </div>
        <p class="tagline"><b>{TITLES[mode]}</b></p>
        {notice.value && <p class="banner" role="status">{notice.value}</p>}

        {mode === 'register' && (
          <>
            <div class="group">
              <label class="label" for="name">Your name</label>
              <input id="name" class="field" value={name} maxLength={24} autoComplete="nickname" required placeholder="What the group calls you" onInput={(e) => setName(e.currentTarget.value)} />
            </div>
            <div class="swatches" role="group" aria-label="Your map colour">
              {RIDER_COLORS.map((c) => (
                <button key={c} type="button" class="swatch" aria-pressed={c === color} aria-label={`Colour ${c}`} onClick={() => setColor(c)}><i style={{ background: c }} /></button>
              ))}
            </div>
          </>
        )}

        <div class="group">
          <label class="label" for="email">Email</label>
          <input id="email" class="field" type="email" inputMode="email" autoCapitalize="none" autoComplete="email" required value={email} onInput={(e) => setEmail(e.currentTarget.value)} />
        </div>

        {mode === 'recover' && (
          <div class="group">
            <label class="label" for="recovery">Recovery code</label>
            <input id="recovery" class="field" autoCapitalize="characters" autoComplete="off" required placeholder="XXXX-XXXX-XXXX-XXXX" value={code} onInput={(e) => setCode(e.currentTarget.value)} />
          </div>
        )}

        <div class="group">
          <label class="label" for="password">{mode === 'recover' ? 'New password' : 'Password'}</label>
          <input id="password" class="field" type="password" required minLength={mode === 'signin' ? 1 : 8} autoComplete={mode === 'signin' ? 'current-password' : 'new-password'} placeholder={mode === 'signin' ? '' : '8 or more characters'} value={password} onInput={(e) => setPassword(e.currentTarget.value)} />
        </div>

        {error && <p class="error" role="alert">{error}</p>}
        <button class="btn primary block" disabled={busy}>
          {mode === 'signin' ? 'Sign in' : mode === 'register' ? 'Create account' : 'Reset password'}
        </button>

        <div class="auth-switch note">
          {mode === 'signin' ? (
            <>
              <button type="button" class="link-btn" onClick={() => go('register')}>Create an account</button>
              <span aria-hidden="true">·</span>
              <button type="button" class="link-btn" onClick={() => go('recover')}>Forgot password?</button>
            </>
          ) : (
            <button type="button" class="link-btn" onClick={() => go('signin')}>Back to sign in</button>
          )}
        </div>
      </form>
    </main>
  );
}
