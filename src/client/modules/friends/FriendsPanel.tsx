import { useEffect, useState } from 'preact/hooks';
import { initial } from '../../app/format';
import { refreshFriends } from '../../app/session';
import { account, friends, session } from '../../app/store';
import { Check, Copy, Trash, UserPlus, X } from '../../ui/icons';
import { dismissInvite, inviteFriend, removeFriend, requestFriend, respondFriend } from '../ride/api';

const POLL_MS = 20_000;

export function FriendsPanel({ onJoin }: { onJoin?: (code: string) => void }) {
  const [code, setCode] = useState('');
  const [message, setMessage] = useState('');
  const [invited, setInvited] = useState<string[]>([]);
  const a = account.value;
  const f = friends.value;
  const rideCode = session.value?.code;

  useEffect(() => {
    void refreshFriends();
    const t = setInterval(() => {
      if (document.visibilityState === 'visible') void refreshFriends();
    }, POLL_MS);
    return () => clearInterval(t);
  }, []);

  if (!a) return <p class="note">Your friend code appears after your first ride.</p>;

  async function run(action: Promise<unknown>, done: string) {
    try {
      await action;
      setMessage(done);
      await refreshFriends();
    } catch (e) {
      setMessage(e instanceof Error ? e.message : 'That did not work');
    }
  }

  async function add() {
    try {
      const { status } = await requestFriend(code.trim().toUpperCase());
      setMessage(status === 'friends' ? 'You are now friends' : 'Friend request sent');
      setCode('');
      await refreshFriends();
    } catch (e) {
      setMessage(e instanceof Error ? e.message : 'That did not work');
    }
  }

  return (
    <>
      <div class="my-code">
        <span>
          <span class="label">Your friend code</span>
          <b class="invite-code num">{a.friendCode}</b>
        </span>
        <button class="icon-btn" aria-label="Copy your friend code" onClick={() => void navigator.clipboard.writeText(a.friendCode).then(() => setMessage('Code copied'))}><Copy /></button>
      </div>

      <div class="add-friend">
        <input class="field code-sm" value={code} maxLength={6} autoCapitalize="characters" autoComplete="off" placeholder="Friend's code" aria-label="Friend's code" onInput={(e) => setCode(e.currentTarget.value.toUpperCase().replace(/[^A-Z0-9]/g, ''))} />
        <button class="btn primary" disabled={code.length !== 6} onClick={() => void add()}><UserPlus /> Add</button>
      </div>
      {message && <span class="note" role="status">{message}</span>}

      {f.invites.map((i) => (
        <div key={i.inviteId} class="row selected">
          <span class="row-main">
            <div class="row-title">{i.from} invited you</div>
            <div class="row-sub num">Ride {i.code}</div>
          </span>
          {onJoin && <button class="btn primary" onClick={() => { void dismissInvite(i.inviteId); onJoin(i.code); }}>Join</button>}
          <button class="icon-btn" aria-label="Dismiss invite" onClick={() => void run(dismissInvite(i.inviteId), 'Invite dismissed')}><X /></button>
        </div>
      ))}

      {f.incoming.map((r) => (
        <div key={r.requestId} class="row selected">
          <span class="avatar" style={{ background: r.color }}>{initial(r.name)}</span>
          <span class="row-main">
            <div class="row-title">{r.name}</div>
            <div class="row-sub">Wants to be friends</div>
          </span>
          <button class="icon-btn accept" aria-label={`Accept ${r.name}`} onClick={() => void run(respondFriend(r.requestId, true), `${r.name} is now a friend`)}><Check /></button>
          <button class="icon-btn" aria-label={`Decline ${r.name}`} onClick={() => void run(respondFriend(r.requestId, false), 'Request declined')}><X /></button>
        </div>
      ))}

      {f.friends.map((r) => (
        <div key={r.id} class="row">
          <span class="avatar" style={{ background: r.color }}>{initial(r.name)}</span>
          <span class="row-main"><div class="row-title">{r.name}</div></span>
          {rideCode && (
            <button class="btn" disabled={invited.includes(r.id)} onClick={() => void run(inviteFriend(r.id, rideCode), `Invite sent to ${r.name}`).then(() => setInvited([...invited, r.id]))}>
              {invited.includes(r.id) ? 'Invited' : 'Invite'}
            </button>
          )}
          <button class="icon-btn" aria-label={`Remove ${r.name}`} onClick={() => { if (confirm(`Remove ${r.name} from your friends?`)) void run(removeFriend(r.id), 'Friend removed'); }}><Trash /></button>
        </div>
      ))}

      {f.outgoing.map((r) => (
        <div key={r.requestId} class="row">
          <span class="avatar off" style={{ background: r.color }}>{initial(r.name)}</span>
          <span class="row-main">
            <div class="row-title">{r.name}</div>
            <div class="row-sub">Request sent</div>
          </span>
          <button class="icon-btn" aria-label={`Cancel request to ${r.name}`} onClick={() => void run(respondFriend(r.requestId, false), 'Request cancelled')}><X /></button>
        </div>
      ))}

      {!f.friends.length && !f.incoming.length && !f.outgoing.length && !f.invites.length && (
        <p class="note">Share your code, or tap the add button next to a rider on a ride.</p>
      )}
    </>
  );
}
