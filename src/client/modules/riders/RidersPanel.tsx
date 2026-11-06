import { distanceM, formatDistance } from '../../../shared/geo';
import { directionsUrl } from '../../../shared/mapsLink';
import type { Rider } from '../../../shared/protocol';
import { ago, initial } from '../../app/format';
import { refreshFriends } from '../../app/session';
import { friends, isIos, me, myPosition, otherRiders, selectedRiderId } from '../../app/store';
import { Check, Navigate, UserPlus } from '../../ui/icons';
import { requestFriend } from '../ride/api';

function Avatar({ rider }: { rider: Rider }) {
  return (
    <span class={`avatar ${rider.online ? '' : 'off'} ${rider.talking ? 'talking' : ''}`} style={{ background: rider.color }}>
      {initial(rider.name)}
    </span>
  );
}

function AddFriend({ rider }: { rider: Rider }) {
  const f = friends.value;
  const known = f.friends.some((x) => x.id === rider.id) || f.outgoing.some((x) => x.id === rider.id);
  if (known) return <span class="icon-btn quiet" aria-label={`${rider.name} is a friend`}><Check /></span>;
  return (
    <button
      class="icon-btn"
      aria-label={`Add ${rider.name} as a friend`}
      onClick={(e) => {
        e.stopPropagation();
        void requestFriend(rider.id).then(refreshFriends);
      }}
    >
      <UserPlus />
    </button>
  );
}

function subtitle(r: Rider): string {
  if (r.talking) return 'Talking';
  if (!r.online) return `Offline · seen ${ago(r.lastSeen)}`;
  if (!r.pos) return 'Waiting for GPS';
  return r.pos.sp >= 5 ? `${Math.round(r.pos.sp)} km/h` : 'Stopped';
}

export function RidersPanel() {
  const here = myPosition.value;
  const distanceTo = (r: Rider) => (here && r.pos ? distanceM(here, r.pos) : Infinity);
  const list = [...otherRiders.value].sort((a, b) => Number(b.online) - Number(a.online) || distanceTo(a) - distanceTo(b));
  const selected = list.find((r) => r.id === selectedRiderId.value);

  if (!list.length) {
    return <p class="note">No one else yet. Invite riders with the button above.</p>;
  }

  return (
    <>
      {selected?.pos && (
        <div class="detail">
          <div class="stats">
            <div class="stat"><span class="label">Away</span><b class="num">{here ? formatDistance(distanceM(here, selected.pos)) : '–'}</b></div>
            <div class="stat"><span class="label">Speed</span><b class="num">{Math.round(selected.pos.sp)}</b></div>
            <div class="stat"><span class="label">Updated</span><b class="num">{ago(selected.pos.ts).replace(' ago', '')}</b></div>
          </div>
          <a class="btn primary block" href={directionsUrl(selected.pos)} target="_blank" rel="noopener">
            <Navigate /> Directions to {selected.name}
          </a>
          <span class="note">
            Opens Google Maps to where {selected.name} is now. Tap again for a fresh position.
            {isIos() && ' Voice pauses while you are out of this app.'}
          </span>
        </div>
      )}
      {list.map((r) => (
        <div key={r.id} class={`row ${r.id === selectedRiderId.value ? 'selected' : ''}`}>
          <button class="row-tap" onClick={() => (selectedRiderId.value = r.id === selectedRiderId.value ? null : r.id)}>
            <Avatar rider={r} />
            <span class="row-main">
              <div class="row-title">{r.name}</div>
              <div class="row-sub">{subtitle(r)}</div>
            </span>
            <span class="row-end num">{Number.isFinite(distanceTo(r)) ? formatDistance(distanceTo(r)) : ''}</span>
          </button>
          <AddFriend rider={r} />
        </div>
      ))}
      {me.value && <span class="note">Everyone on this ride can see your location until you leave.</span>}
    </>
  );
}
