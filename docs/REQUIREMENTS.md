# Requirements audit

Every requirement raised during the build, with its status and how it was proven.

- **Done**: built and tested.
- **Needs key**: built, and waiting for a key only the account owner can create. See the setup guide.
- **Needs device**: built, but only real hardware can prove it.
- **Not possible**: a platform rule prevents it. The closest alternative is listed.

Tests: `unit` (126), `call` (two real Chrome browsers over WebRTC), `webkit` (Safari engine), `layout` (four phone sizes), `android` (the real APK on Android 15), `live` (the deployed site, including a real call through the relay).

## Voice and call

| Requirement | Status | Proof or note |
|---|---|---|
| Group voice chat, like Discord | Done | call: audio captured at the receiver |
| Noise cancelling for wind | Done | Measured on simulated wind. Needs a road test |
| Engine and traffic noise | Done | Measured on simulated engines, traffic and horns. Horns can open the mic briefly |
| Crisp voice at high speed | Needs device | 100% of words on clean speech, 73% on a highway mix, simulated. Noise filter setting lets riders tune it |
| Low latency | Needs device | Direct links measured here. Real figures need real networks |
| Auto push-to-talk | Done | unit and call: gate opens on speech, stays closed on wind |
| Mute a person for yourself only | Done | call: stored on the phone; the muted rider keeps sending |
| Call deck: mute, end call, participants, volume | Done | call |
| Change speaker and mic, Bluetooth | Done | call and android on speaker. Bluetooth needs a real headset. iPhone: Control Center |
| Audio cues: join, leave, reconnect, call cut | Done | unit and call |
| Voice through the Cloudflare relay | Done | live call: 39 ms to the relay, real audio received. Real mobile networks still need a ride |

## Map, tracking and planning

| Requirement | Status | Proof or note |
|---|---|---|
| Mappls in-app map | Needs Mappls access | Mappls refused the app access when last tested, so riders get the backup map. Settings now shows Mappls' own reason. Real Mappls map never yet drawn |
| Button hands off to Google Maps | Done | call: two-wheeler navigation link. Free, no key |
| Ride planner: total ride, stops, group sync | Done | call: name, time, stops, order reach other riders |
| Rearrange and remove stops | Done | stops: drag handle and remove on every row, real touch drag, Safari engine, 14-stop list, reach other riders. A finger on a real iPhone is untested |
| Stop types on every screen | Done | stops: all 7 show from 360 px phones to 1920 px desktops |
| Route and stop pins on the map | Done | Real ride checked by eye: road-following route with direction arrows, pins exact to the metre through zoom, selected stop stands out, long-press pin. Mappls version of these is built but has never drawn |
| Search for places | Done | live: free search works |
| Search from Google Maps | Done | Search on Google Maps button, then share or paste back |
| Google search inside the app | Needs key | Built and unit-tested. Google requires a billing account, so this is the owner's choice |
| Tap a stop for directions | Done | call |
| Check riders' locations | Done | call and live |
| Directions to a selected rider | Done | call |

## Ride lifecycle

| Requirement | Status | Proof or note |
|---|---|---|
| Start ride for the whole group | Done | call and live |
| Recording begins for all at Start | Done | call: nothing recorded before it |
| Call joins with the ride | Done | android: automatic. Web and iPhone: one tap, a browser rule |
| Map behaves differently while riding | Done | Follows the group, shows next stop and timer |
| End ride, summary for everyone | Done | call |

## Stats, accounts, security

| Requirement | Status | Proof or note |
|---|---|---|
| Per-rider daily stats: speed map, averages, distance, speed log | Done | unit and call |
| Stats survive closing the app | Done | Recovered and uploaded on next launch |
| Registration and sign-in | Done | call and live |
| Passwords hashed, sessions revocable, lockout | Done | unit and live |
| Password recovery with no paid email | Done | call: recovery code. Owner can also reset |
| Friend requests | Done | call |
| Invitation link, QR, WhatsApp | Done | call |
| Owner portal: view and manage everything | Done | call and live: rides, riders, users, stats, block, reset |
| Security headers, rate limits, origin checks | Done | live |
| Private app: approval required | Done | call and live: unapproved accounts are refused everywhere; approved in the portal |
| Free limit guard and warnings | Done | unit and live: eight meters in the portal, warn at 70%, lock at 95%. Estimates |
| Keep calls running past a limit | Done | live call: moved to direct links and back with no taps, audio throughout |
| 8 to 9 hour calls | Needs device | Budget fits with room to spare. A 25-minute live soak is the longest tested |
| Owner password change in the portal | Done | call: old password stops at once |

## Platform, quality, delivery

| Requirement | Status | Proof or note |
|---|---|---|
| Everything free | Done | Cloudflare free plan, free services. Google search is opt-in only |
| Android APK to share | Done | Signed release build, tested on Android 15 |
| Android permissions and SDK setup | Done | android: first-run prompt, service types, screen-off capabilities |
| Google Play services | Done | android: Nearby starts on real Play services |
| Screen-off voice and GPS on Android | Done | android: 21 s with the screen off, not killed |
| iPhone web parity | Needs device | webkit passes, including the voice chain. A real iPhone has not been tested |
| iPhone with the screen off, in the web app | Not possible | Apple stops web apps when locked, even installed from Chrome. Pocket mode is the free workaround: black screen, Guided Access. See docs/IPHONE.md |
| iPhone with the screen off, native app | Needs device | Compiles in CI and is published. Free install through SideStore, refreshed within 7 days. Never run on a real iPhone |
| Nearby permission, Android | Done | android: asked when joining the call, so it is settled before the internet is lost |
| Nearby voice, Android | Needs device | Built. Starts on Play services and voice path tested, but the radio link needs two phones |
| Nearby mesh, 8 to 10 riders | Needs device | Built. Routing and the real link code pass on simulated radios (groups, lines, splits, dropouts). Real radios need several phones |
| Nearby, web | Not possible | Browsers have no such feature on any phone. Settings says so plainly |
| Nearby, iPhone app | Not possible today | Google's version is unproven between iPhone and Android; Apple's only links iPhones |
| Low battery | Needs device | Designed for it throughout. Only a real ride can measure it |
| Low RAM | Done | android: about 176 to 210 MB in the pocket |
| Modular monolith, 10 riders | Done | Enforced at 10 on the server |
| Cloudflare deployment | Done | live at https://ridzz.ridzz.workers.dev |
| Premium mobile UI, no glitches | Done | layout: zero faults at four phone sizes, plus visual review |
| REA installed | Done | Connected after restarting Claude Code |
| Reverse-engineer Sena and Riding Verse | Partly | Public listings and reviews only. APKs could not be downloaded; needs copies from a phone |
