# Slipstream: plan and status

Group intercom and ride tracking for up to 10 riders. Android riders install a shared APK and iPhone riders use the web app. Every service must stay free. The priorities, in order: battery and RAM, crisp voice in noise, low latency, a simple premium interface.

## What is built

| Area | Features |
|---|---|
| **Ride lifecycle** | Planning, then Start ride for the whole group, then End ride with a summary for everyone. The server owns the phase |
| **Accounts and security** | Email and password, hashed with PBKDF2. Revocable sessions, lockout, recovery code, owner reset, security headers, rate limits |
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

For one 8-hour ride with 10 riders:

| Limit | Free allowance | Estimated use |
|---|---|---|
| Durable Object requests | 100,000 a day | About 3,000 (WebSocket messages bill at 20:1) |
| Durable Object duration | 13,000 GB-s a day | About 3,600 |
| Rows written | 100,000 a day | About 5,000 (positions persist once a minute) |
| Realtime SFU and TURN egress | 1,000 GB a month | Under 10 GB per ride, with gated audio |

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
- **iPhone web.** Apple does not let websites use the mic or GPS with the screen locked or the browser in the background. iPhone riders must keep Slipstream open on screen, mounted and ideally charging. The app keeps the screen awake and recovers by itself on return, but opening Google Maps pauses their voice. Speaker choice comes from Control Center, and per-rider volume is mute-only. The Safari engine is tested, but a real iPhone is not. WebKit reports also suggest the mic can misbehave in Home Screen apps, so riders should test Safari first.
- **Bluetooth helmets.** Routing is built, but the emulator has no Bluetooth. On the emulator the capture source was `CAMCORDER`, which on some phones may bypass a Bluetooth mic. Needs a real phone and intercom.
- **Battery.** Not measured. An emulator cannot give meaningful numbers, so this needs a real ride.
- **Horns.** They are loud and tonal, so a horn can open the mic for about a second.
- **Cloudflare voice relay.** The relay code follows the docs and has unit tests, but it has never run against the real service, because that needs keys only the owner can create. Until they are set, voice uses direct links, which can fail on cellular networks. See the README.
- **Nearby.** It starts on real Google Play services and its voice path is tested, but the radio link itself needs two real Android phones. Audio and alerts over it are unproven in the field.
- **Password recovery.** There is no email reset, because free sending services typically need a card. Losing both the password and the recovery code means asking the owner for a reset. Email addresses are not verified.
- **Mappls.** Mappls publishes no free quota, and its terms allow removing free access after 3 months unused. The adapter follows Mappls' SDK docs and has unit tests, but it has never run with a real key. If it fails, the app switches to the backup map by itself. Ola Maps is the next choice if Mappls proves awkward: 100,000 free map loads a month, published, and no credit balance needed within that.
- **Planning is open.** Anyone on a ride can edit the plan, which suits a group of friends.

## Next

1. **Keys.** Mappls, Cloudflare voice relay and TURN, then test each live.
2. **Road test.** Record real helmet noise at 40, 80 and 120 km/h, retune against it, and measure battery on a real ride.
3. **Two real Android phones.** Prove the Nearby radio link and Bluetooth helmet routing.
4. **A real iPhone.** Prove the web app, starting in Safari.
5. **Mappls search** for Indian places, once a real key exists to test with.
6. **Crash detection**, if the group wants it.
