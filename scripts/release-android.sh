#!/bin/sh
# Builds the signed APK and publishes it at /download/Slipstream.apk.
# Needs JAVA_HOME and ANDROID_HOME set, and the key in ~/.slipstream.
set -e
rm -rf public/download # Otherwise the last APK gets packed inside the new one.
pnpm exec vite build
APP_URL=https://ridzz.ridzz.workers.dev pnpm exec cap sync android
(cd android && ./gradlew assembleRelease)
mkdir -p releases public/download
cp android/app/build/outputs/apk/release/app-release.apk releases/Slipstream.apk
cp releases/Slipstream.apk public/download/Slipstream.apk
pnpm run deploy
