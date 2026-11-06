/** Settings the receiver asks of the sender. An Opus sender obeys the fmtp line in the remote description. */
const OPUS = {
  minptime: '10',
  useinbandfec: '1', // recovers lone lost packets, common during cell handovers
  usedtx: '1',
  stereo: '0',
  'sprop-stereo': '0',
  maxaveragebitrate: '24000',
  maxplaybackrate: '16000', // wideband: Bluetooth headsets capture no more than this
};

export function tuneOpus(sdp: string): string {
  const pt = sdp.match(/a=rtpmap:(\d+) opus\/48000/i)?.[1];
  if (!pt) return sdp;
  const line = new RegExp(`a=fmtp:${pt} ([^\\r\\n]*)`);
  const current = sdp.match(line)?.[1];
  if (current === undefined) return sdp.replace(new RegExp(`(a=rtpmap:${pt} opus/48000[^\\r\\n]*\\r?\\n)`, 'i'), `$1a=fmtp:${pt} ${encode({})}\r\n`);
  const params = Object.fromEntries(current.split(';').filter(Boolean).map((p) => p.trim().split('=') as [string, string]));
  return sdp.replace(line, `a=fmtp:${pt} ${encode(params)}`);
}

function encode(existing: Record<string, string>): string {
  return Object.entries({ ...existing, ...OPUS }).map(([k, v]) => `${k}=${v}`).join(';');
}
