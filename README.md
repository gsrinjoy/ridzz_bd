# Slipstream

Group voice and live tracking for motorcycle rides, for up to 10 riders. One codebase runs as a web app and as an Android APK. Everything runs on free tiers.

**Live at https://ridzz.ridzz.workers.dev** (owner portal at `/admin`).

See [docs/PLAN.md](docs/PLAN.md) for the design, measured results, limits and roadmap, and [docs/REQUIREMENTS.md](docs/REQUIREMENTS.md) for every requirement and how it was proven.

## Run it locally

```sh
pnpm install
cp .dev.vars.example .dev.vars
pnpm serve        # builds, then serves app and API at http://localhost:8787
```

`pnpm dev` runs Vite with hot reload; start `pnpm dev:api` beside it for the API.

## Deploy

Needs a free Cloudflare account. No card is required for the services used here.

```sh
pnpm exec wrangler login
pnpm exec wrangler secret put TOKEN_SECRET   # any long random string; changing it logs riders out of rides
pnpm exec wrangler secret put ADMIN_TOKEN    # your password for /admin
pnpm run deploy
```

The app is then live at `https://ridzz.<your-subdomain>.workers.dev`, and the owner portal at `/admin`.

### Optional keys

Each one is a Worker secret, set with `wrangler secret put <NAME>`. The app works without them, with the fallback shown.

| Secret | Gives you | Without it | Where to get it |
|---|---|---|---|
| `MAPPLS_KEY` | Mappls as the in-app map | Free OpenFreeMap backup map | [Mappls console](https://auth.mappls.com/console), then restrict the key to your domain |
| `SFU_APP_ID`, `SFU_APP_SECRET` | Voice relayed through Cloudflare, for reliability on mobile data | Direct phone-to-phone links, which can fail on cellular | Cloudflare dashboard, Realtime, SFU |
| `TURN_KEY_ID`, `TURN_KEY_TOKEN` | Connections through strict networks | Some networks may not connect | Cloudflare dashboard, Realtime, TURN |
| `GOOGLE_PLACES_KEY` | Google search inside the app | Free search, plus a Search on Google Maps button | Google Cloud console. Needs a billing account, so set a low daily quota |

## Build the Android APK

Needs JDK 21 and the Android SDK (platform 36), both free.

```sh
pnpm build
APP_URL=https://ridzz.<your-subdomain>.workers.dev pnpm exec cap sync android
cd android && ./gradlew assembleDebug
```

The APK is at `android/app/build/outputs/apk/debug/app-debug.apk`. It loads the deployed site, so web updates reach Android riders without a new APK. Only changes to the native code need one.

For a release build to share, run `./gradlew assembleRelease`. It signs with the key in `~/.slipstream/`. **Back that folder up**: Android only accepts updates signed with the same key.

## Test

| Command | What it covers |
|---|---|
| `pnpm test` | Unit tests |
| `node tests/e2e/run.mjs <outDir> [mic.wav]` | Two real Chrome instances through a full ride, over real WebRTC |
| `node tests/e2e/webkit.mjs <outDir>` | The Safari engine at iPhone size, including the voice pipeline |
| `node tests/e2e/ui-audit.mjs <outDir>` | Every rider screen at four phone sizes, for layout faults |
| `node tests/e2e/nearby-voice.mjs` | The local voice path on real WebCodecs |
| `node tests/e2e/android.mjs` | The real APK on a booted emulator; needs an APK built with `APP_URL=http://localhost:8792` |
| `OWNER=<password> node tests/e2e/live.mjs <url>` | A deployed site, end to end; removes its own test data |

## Layout

A modular monolith: one deployable Worker, with code split into modules that talk through small public surfaces.

```
src/shared/           Wire protocol, geo, Maps links, ride stats types
src/server/modules/   rides, voice, directory (accounts, friends), places, admin
src/client/modules/   voice, map, stops (planner), riders, friends, stats, location, ...
src/client/admin/     Owner portal, its own chunk
android/              Capacitor shell, foreground service, audio routing
scripts/              Map style builder
tests/                unit, audio (noise simulators), e2e
```
