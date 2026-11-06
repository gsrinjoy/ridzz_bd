import { render } from 'preact';
import { AuthScreen } from './app/AuthScreen';
import { Home } from './app/Home';
import { RideScreen } from './app/RideScreen';
import { connect } from './app/session';
import { account, pendingShare, session } from './app/store';
import './ui/styles.css';

function App({ invite }: { invite: string | null }) {
  if (!account.value) return <AuthScreen />;
  return session.value ? <RideScreen /> : <Home invite={invite} />;
}

const url = new URL(location.href);
const root = document.getElementById('app') as HTMLElement;

// The owner portal is its own chunk: riders never download it.
if (url.pathname.startsWith('/admin')) {
  void import('./admin/AdminApp').then(({ AdminApp }) => render(<AdminApp />, root));
} else {
  start();
}

function start() {
  const invite = url.pathname.match(/^\/r\/([A-Z0-9]{6})$/i)?.[1]?.toUpperCase() ?? null;

  // Android's share sheet lands here when a place is shared from Google Maps.
  if (url.pathname === '/share') {
    const shared = [url.searchParams.get('title'), url.searchParams.get('text'), url.searchParams.get('url')].filter(Boolean).join('\n');
    if (shared) pendingShare.value = shared;
    history.replaceState(null, '', '/');
  }

  if (session.value && account.value) connect(session.value);
  render(<App invite={invite} />, root);

  if ('serviceWorker' in navigator && import.meta.env.PROD) {
    void navigator.serviceWorker.register('/sw.js');
  }
}
