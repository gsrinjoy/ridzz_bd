// CommonJS JavaScript: TypeScript 7 removed the API Capacitor used to read a .ts config.
// The APK is a thin shell around the deployed site, so web and Android always run the
// same code. Set APP_URL to your Worker URL before `cap sync`.
const url = process.env.APP_URL;

module.exports = {
  appId: 'app.slipstream.rider',
  appName: 'Slipstream',
  webDir: 'dist',
  android: { backgroundColor: '#08090B' },
  // Light icons always: left to follow the phone, they vanish against the dark app in light mode.
  plugins: { SystemBars: { style: 'DARK' } },
  ...(url ? { server: { url, cleartext: url.startsWith('http://') } } : {}),
};
