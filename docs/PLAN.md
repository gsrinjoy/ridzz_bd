# Slipstream: plan and status

Group intercom and ride tracking for up to 10 riders. Android riders install a shared APK and iPhone riders use the web app. Every service must stay free. The priorities, in order: battery and RAM, crisp voice in noise, low latency, a simple premium interface.

## What is built

| Area | Features |
|---|---|
| **Ride lifecycle** | Planning, then Start ride for the whole group, then End ride with a summary for everyone. The server owns the phase |
| **Accounts and security** | Private: the owner approves every account. Email and password, hashed with PBKDF2. Revocable sessions, lockout, recovery code, owner reset, security headers, rate limits |
| **Free limit guard** | Seven usage meters in the owner portal. Warns at 70%, and at 95% locks the feature, so anything billable stops before it costs money |
| **Voice** | Group call, auto-talk, hold-to-talk, open mic, mute, wind and road noise reduction with Light, Balanced and Strong settings, self-healing links |
| **Nearby (Android)** | Phone-to-phone voice, location and alerts over Google Nearby Connections when the internet drops, relayed across up to 3 hops |
| **Call deck** | Participants, timer, link quality, mute, speaker and mic selection, speaker test, end call, per-rider volume, mute a rider for yourself only |
| **Call sounds** | Join, leave, rider joined, rider left, reconnecting, reconnected, call cut, mute. Short and quiet, with rules that keep network blips silent |
| **Ride planner** | Ride name, meet time, search, Search on Google Maps, Google Maps link import, Android share sheet, long-press on map, ordered stops, reordering, total distance and time, per-leg distance |
| **Map** | Mappls when a key is set, with automatic fallback to a free map. Rider pins, talking ring, road route, tap a stop or rider for details |
| **Navigation** | Directions to any stop or rider, or the whole route, through Google Maps in two-wheeler mode. Free and keyless |
| **Rider tracking** | Live position, speed, distance, offline status, adaptive update rate |
| **Alerts** | Fuel, stop, regroup, hazard, hold-for-SOS with location. Tone plus spoken message |
| **Invites and friends** | Link, QR code, WhatsApp, ride code. Friend codes, requests, ride invites |
| **Ride stats** | Per rider, per day: distance, moving and stopped time, average and top speed, speed map, 5-minute speed log, time in speed bands |
| **Owner portal** | `/admin`: totals, service status, live rides and riders, close a ride, remove a rider, block, delete or reset users, view their ride stats |
| **Android** | Foreground service, screen-off voice and GPS, Bluetooth and speaker routing, battery exemption prompt, share-to-app |

## Architecture

```
Rider phone (web app, or the same app in the Android shell)
  mic -> AudioWorklet: high-pass -> RNNoise -> blend -> VOX gate -> AGC -> limiter -> Opus
                    |                                             |
                 WebSocket                                     WebRTC
                    |                                             |
Cloudflare Worker -> RideRoom Durable Object (one per ride)    Realtime SFU, or direct links
                  -> Directory Durable Object (people, friends, ride logs)
                  -> Static assets (the app)
```

Decisions worth knowing:

- **One codebase, thin Android shell.** Web and Android cannot drift apart, and a web deploy updates both. Native code does only what the web cannot: staying alive with the screen off, and audio routing.
- **Durable Objects as the database.** SQLite-backed objects are on the Workers Free plan, need no separate database, and put a ride's state beside its live connections.
- **A closed gate sends nothing.** RTP stops entirely between words, so an idle radio can sleep.
- **Batched location.** The server fans out positions every 3 seconds, so a phone's radio wakes once per interval rather than once per rider.
- **Stats add no radio or GPS use.** They reuse fixes the app already receives, and upload once at the end of a ride.
- **Nearby is a failover.** Scanning costs battery, so it starts only after the internet has been down for 6 seconds, and stops 30 seconds after it returns.

## Ride lifecycle

| | Planning | Riding | Finished |
|---|---|---|---|
| Main action | Host: Start ride | Talk controls | Ride summary |
| Recording | Off | On for everyone | Saved for everyone |
| Call | Optional lobby | Joins automatically on Android; one tap on web | Ends with a cue |
| Map | Plan and route | Follows the group, next stop, timer | Speed map in the summary |
| GPS | Low power | Full accuracy | Off |

The server owns the phase, so everyone moves together and a rider arriving late lands in the right place. Only the host can start or end, unless the host is offline, so a dead phone cannot strand the group.

## Free-tier budget

For one 9-hour ride with 10 riders:

| Limit | Free allowance | Estimated use | Share |
|---|---|---|---|
| Durable Object time | 13,000 GB-s a day | About 4,150 | 32% of a day |
| Durable Object requests | 100,000 a day | About 3,300 (socket messages bill at 20:1) | 3% of a day |
| Map files through the Worker | 100,000 Worker requests a day | About 20,000 (estimate: 10 riders, new tiles as they move, browsers cache the rest) | 20% of a day. Near the limit, tiles go direct to their host |
| Rows written | 100,000 a day | About 5,400 (positions persist once a minute) | 5% of a day |
| Voice relay data, typical | 1,000 GB a month | About 0.2 GB, one rider talking 20% of the time | 0.02% of a month |
| Voice relay data, worst case | 1,000 GB a month | About 8.7 GB, all ten on open mic for 9 hours | 0.9% of a month |

So a 9-hour ride is comfortable: about three of them fit in one day, and the relay allows over 100 worst-case rides a month.

## Staying on the air

A call has three paths, and moves between them with no taps:

| Path | Cost | When | Limit |
|---|---|---|---|
| 1. Cloudflare relay | Free to 1,000 GB a month | Normal | The most reliable on mobile data |
| 2. Direct phone-to-phone | Free, always | Relay locked at 95%, or switched off in the portal | Can fail on strict mobile networks |
| 3. Nearby (Android only) | Free, always | Internet lost for 6 seconds | Riders in radio range only |

Moving from 1 to 2 is driven by the server, which tells every rider on the ride. It is proven on the live site. Moving to 3 cannot be: with no internet the server cannot reach the phone, so the phone decides for itself. Near a daily limit, eco mode slows location updates so the ride can finish. If a daily Durable Object limit is hit anyway, voice over the relay keeps running, because it does not pass through them; location sharing stops until the reset at 00:00 UTC.

## The local mesh

Google's Nearby Connections links two phones and does no routing. Its engineers put the practical limit at 3 or 4 radio links per phone, and a Bluetooth helmet takes one. So a group of 8 cannot simply all connect to each other. Slipstream builds its own mesh on top:

| Problem | How it is handled |
|---|---|
| Too few links for everyone to connect | Each phone keeps 3 links. Riders reach the rest through neighbours |
| The group splits into islands | The 4th link is reserved. After 8 settled seconds, a phone that finds a rider it cannot reach spends it to join the two parts |
| Riders strung out in a line | Voice hops rider to rider, up to 9 hops, enough for 10 riders in a single line |
| Packets looping | Each carries a sender and number, and every phone passes a packet on once |
| Scanning disturbs links and drains power | It stops 30 seconds after the mesh settles, and restarts if the mesh changes |
| Two settled groups riding back together | Each phone takes one 8-second look every 2 minutes, at its own moment, so the halves find each other |
| Only one rider loses signal | Riders within 1 km of a dropped rider start listening too, because both sides must be scanning |
| Hearing someone twice | While a rider is online, their Nearby audio is ignored |

Each hop adds delay, so a rider at the far end of a long line hears speech later than a neighbour. Radio range is about 100 m in the open by Google's figure, and less on real bikes, so a stretched-out group may not stay connected. Nearby is a safety net for dead zones, not a replacement for the relay.

A rider who loses signal hears only riders the mesh can reach. Voice does not cross from the internet call into the mesh, so anyone outside radio range stays silent to them until they are back online.

The routing runs against 8 and 10 simulated riders in `tests/unit/mesh.test.ts`, including random arrival orders and random road spacing. `tests/unit/nearbyLink.test.ts` runs the real link code on 8 pretend radios. **The radio itself has not been tested on real phones.**

## Measured results

These come from speech mixed with **simulated** noise. They guided the design, but they are not a road test.

**Noise chain on the finished build** (Whisper word errors, lower is better). "Caught" is the share of speech the gate transmitted. "False-open" is time on air from noise alone during a 21-second clip.

| Condition | Raw mic | After chain | Speech caught | False-open |
|---|---|---|---|---|
| Single cylinder, 3000 rpm | 11% | 15% | 98% | 0% |
| Twin, 5000 rpm | 16% | 26% | 99% | 24% (first seconds only) |
| Inline four, 7000 rpm | 44% | 76% | 86% | 25% (first seconds only) |
| City traffic, a horn every 4 s | 22% | 38% | 97% | 31% |
| Highway: wind, engine, traffic | 22% | 29% | 98% | 27% |
| Wind at 120 km/h | 20% | 30% | 98% | 0% |

The raw mic scores better with Whisper in every row, and that needs reading carefully. Whisper tolerates noise far better than a person in a helmet, and "raw" means the whole group hears unfiltered wind. In the same tests the chain cut wind by 15 to 22 dB. This is the reason for the Noise filter setting, and the first thing real recordings must settle.

**Real call through WebRTC and Opus**, recorded at the receiving browser:

| Mic input | Words heard |
|---|---|
| Clean speech | 100% |
| Highway mix | 73% |
| City traffic with horns | 68% |

**On Android 15 (emulator):** with the screen off, the service stayed foreground with microphone and location types (`0x88`), capability `L-MNFUA`, the mic was not silenced, GPS kept arriving, and the process was not killed. RAM was about 176 to 210 MB in the pocket and up to 240 MB with the map open, including the WebView.

**CPU:** the capture chain takes 155 µs per 10 ms frame, or 1.55% of one core on an Apple Silicon Mac. Expect several times that on a mid-range phone.

## Known limits

- **No road test yet.** Noise figures are simulated. Real wind in a helmet may differ a lot.
- **Extreme wind.** With speech buried below the noise (harsh wind at 120 km/h, -12 dB in the speech band), no software recovers it. Mic hardware matters more than anything here: a boom mic with a wind sock, inside the helmet.
- **iPhone web.** Apple does not let websites use the mic or GPS with the screen locked or the browser in the background, even when installed from Chrome. Pocket mode is the free answer: the app stays open on a fully black screen, with Guided Access for touch. Opening Google Maps pauses voice, and it recovers on return. Speaker choice comes from Control Center, and per-rider volume is mute-only. The Safari engine is tested, but a real iPhone is not. WebKit reports suggest the mic can misbehave in Home Screen apps, so riders should use Safari.
- **iPhone app.** A native build with background audio and GPS compiles and is published, installed free through SideStore. It has never run on a real iPhone, so screen-off behaviour is unproven. Free installs need a Wi-Fi refresh within 7 days. See docs/IPHONE.md.
- **Bluetooth helmets.** Routing is built, but the emulator has no Bluetooth. On the emulator the capture source was `CAMCORDER`, which on some phones may bypass a Bluetooth mic. Needs a real phone and intercom.
- **Battery.** Not measured. An emulator cannot give meaningful numbers, so this needs a real ride.
- **Horns.** They are loud and tonal, so a horn can open the mic for about a second.
- **Cloudflare voice relay.** Proven on the live site from a fixed connection: 39 ms to the relay, with real audio received. Moving between cell towers at speed still needs a real ride.
- **Free limit meters are estimates.** They come from the app's own counters, not from Cloudflare's billing. The Cloudflare dashboard has the exact figures.
- **Nearby.** It starts on real Google Play services and its voice path is tested, but the radio link itself needs two real Android phones. Audio and alerts over it are unproven in the field.
- **Password recovery.** There is no email reset, because free sending services typically need a card. Losing both the password and the recovery code means asking the owner for a reset. Email addresses are not verified.
- **Mappls.** Mappls publishes no free quota, and its terms allow removing free access after 3 months unused. The key is valid, but Mappls answers `ASSET_ACCESS_DENIED` until Map SDK access is enabled for the app, so the adapter has not yet drawn a real Mappls map. Until then the app uses the backup map by itself. Ola Maps is the next choice if Mappls proves awkward: 100,000 free map loads a month, published, and no credit balance needed within that.
- **Planning is open.** Anyone on a ride can edit the plan, which suits a group of friends.

## Next

1. **Mappls access.** Enable Map SDK for the app in the Mappls console, then test the map live.
2. **Road test.** Record real helmet noise at 40, 80 and 120 km/h, retune against it, and measure battery on a real ride.
3. **Two real Android phones.** Prove the Nearby radio link and Bluetooth helmet routing.
4. **A real iPhone.** Prove pocket mode in Safari, then the SideStore app with the screen locked.
5. **Mappls search** for Indian places, once a real key exists to test with.
6. **Crash detection**, if the group wants it.
