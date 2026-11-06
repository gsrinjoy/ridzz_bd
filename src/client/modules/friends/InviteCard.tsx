import { useMemo, useState } from 'preact/hooks';
import { renderSVG } from 'uqr';
import { Copy, Share } from '../../ui/icons';

export function InviteCard({ code }: { code: string }) {
  const [copied, setCopied] = useState(false);
  const link = `${location.origin}/r/${code}`;
  const message = `Join my ride on Slipstream: ${link}`;
  const qr = useMemo(() => renderSVG(link, { border: 2 }), [link]);

  async function copy() {
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard refused: the link is on screen to copy by hand.
    }
  }

  return (
    <div class="invite">
      <div class="invite-qr" aria-label="QR code for the ride link" role="img" dangerouslySetInnerHTML={{ __html: qr }} />
      <div class="invite-side">
        <span class="label">Ride code</span>
        <b class="invite-code num">{code}</b>
        <span class="invite-link" title={link}>{link.replace(/^https?:\/\//, '')}</span>
      </div>
      <div class="invite-actions">
        <button class="btn" onClick={copy}><Copy /> {copied ? 'Copied' : 'Copy link'}</button>
        <a class="btn" href={`https://wa.me/?text=${encodeURIComponent(message)}`} target="_blank" rel="noopener">WhatsApp</a>
        {'share' in navigator && (
          <button class="btn" onClick={() => void navigator.share({ title: 'Join my ride', text: message }).catch(() => undefined)}><Share /> Share</button>
        )}
      </div>
    </div>
  );
}
