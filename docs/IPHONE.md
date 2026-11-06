# Slipstream on iPhone

There are two free ways to ride. Start with the first; it works today with nothing to install.

| | Web app with pocket mode | iPhone app through SideStore |
|---|---|---|
| Install | None, open the link in Safari | About 20 minutes, once, with a computer |
| Call and GPS with the phone locked | No, it must stay unlocked | Designed to, not yet proven on a real iPhone |
| Upkeep | None | Refreshes every 7 days, on Wi-Fi |
| Cost | Free | Free |

## Option 1: Web app with pocket mode

1. Open https://ridzz.ridzz.workers.dev in **Safari**.
2. Sign in and join the ride.
3. Tap the moon button for **Ride mode**. After 10 seconds the screen goes fully black. Tap to wake it.
4. **Do not press the side button to lock the phone.** That stops voice and GPS.

The screen stays on, but on OLED iPhones black pixels are off, so it uses far less power than a lit screen. Keep the phone on a charger for long rides.

**For a pocket, turn on Guided Access.** It stops accidental touches.

1. Once only: open Settings, Accessibility, Guided Access, and turn it on.
2. In Ride mode, triple-click the side button, then tap **Start**.
3. To finish, triple-click the side button and enter your passcode.

Opening Google Maps pauses your voice until you come back. The app reconnects by itself.

## Option 2: iPhone app through SideStore

This is a real app, built to keep voice and GPS running with the screen locked. It has been built, but **it has not yet been tried on a real iPhone**, so treat it as a test.

**What you need:** a computer for the first setup, Wi-Fi, a free Apple Account, and iOS 15 or later.

### Set up SideStore, once

Follow the [official SideStore install guide](https://docs.sidestore.io/docs/installation/install):

1. Install [iloader](https://iloader.app) on a computer. On the iPhone, install **LocalDevVPN** from the App Store.
2. Connect the iPhone by USB, trust the computer, open iloader, sign in, and choose **Install SideStore (Stable)**.
3. On the iPhone, open Settings, General, VPN & Device Management, and trust your account. Turn on Developer Mode if asked.
4. Open LocalDevVPN and tap **Connect**. Open SideStore and sign in.

### Install Slipstream

1. On the iPhone, download [Slipstream.ipa](https://github.com/gsrinjoy/ridzz_bd/releases/download/ios-latest/Slipstream.ipa) in Safari.
2. With LocalDevVPN connected, open SideStore, go to **My Apps**, tap **+**, and choose the downloaded file.
3. Open Slipstream. Allow the microphone and location.

### Keep it working

Apple expires free installs after 7 days. SideStore refreshes them in the background, but only while **LocalDevVPN is connected on Wi-Fi**, so connect it at home every few days. If the app stops opening, connect LocalDevVPN and refresh it in SideStore. A free Apple Account allows 3 apps at once, including SideStore.

## Nearby

Nearby needs the Android app. It cannot run in a browser on any phone, and the iPhone app does not include it: Google's version is not proven between iPhone and Android, and Apple's only connects iPhones to iPhones.
