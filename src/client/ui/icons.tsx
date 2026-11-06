import type { ComponentChildren } from 'preact';

const Icon = ({ children }: { children: ComponentChildren }) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    {children}
  </svg>
);

export const Mic = () => <Icon><rect x="9" y="3" width="6" height="11" rx="3" /><path d="M5 11a7 7 0 0 0 14 0M12 18v3" /></Icon>;
export const MicOff = () => <Icon><path d="m3 3 18 18M9 9v2a3 3 0 0 0 5 2M15 10V6a3 3 0 0 0-6-1M5 11a7 7 0 0 0 11 6M19 11a7 7 0 0 1-.6 2.8M12 18v3" /></Icon>;
export const Users = () => <Icon><circle cx="9" cy="8" r="3.5" /><path d="M3 20a6 6 0 0 1 12 0M16 4.6a3.5 3.5 0 0 1 0 6.8M21 20a6 6 0 0 0-4-5.6" /></Icon>;
export const Pin = () => <Icon><path d="M12 22s7-6.4 7-12a7 7 0 0 0-14 0c0 5.6 7 12 7 12Z" /><circle cx="12" cy="10" r="2.5" /></Icon>;
export const Bell = () => <Icon><path d="M6 9a6 6 0 0 1 12 0c0 6 2.5 7.5 2.5 7.5h-17S6 15 6 9ZM10 20a2.2 2.2 0 0 0 4 0" /></Icon>;
export const Sliders = () => <Icon><path d="M4 7h10M18 7h2M4 17h2M10 17h10" /><circle cx="16" cy="7" r="2" /><circle cx="8" cy="17" r="2" /></Icon>;
export const Navigate = () => <Icon><path d="m3 11 18-8-8 18-2-8-8-2Z" /></Icon>;
export const Crosshair = () => <Icon><circle cx="12" cy="12" r="7" /><path d="M12 2v4M12 18v4M2 12h4M18 12h4" /></Icon>;
export const Group = () => <Icon><path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" /></Icon>;
export const Moon = () => <Icon><path d="M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5Z" /></Icon>;
export const Trash = () => <Icon><path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13" /></Icon>;
export const Share = () => <Icon><path d="M12 15V4M8 8l4-4 4 4M5 13v6a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-6" /></Icon>;

export const Phone = () => <Icon><path d="M5 4h4l2 5-2.5 1.5a11 11 0 0 0 5 5L15 13l5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2Z" /></Icon>;
export const PhoneOff = () => <Icon><path d="M3 15c5-5 13-5 18 0l-2.5 2.5-3-1.5v-2.5a10 10 0 0 0-7 0V16l-3 1.5L3 15Z" /></Icon>;
export const Speaker = () => <Icon><path d="M4 9v6h4l5 4V5L8 9H4ZM16.5 9a4 4 0 0 1 0 6M19 6.5a8 8 0 0 1 0 11" /></Icon>;
export const SpeakerOff = () => <Icon><path d="M4 9v6h4l5 4V5L8 9H4ZM17 10l4 4M21 10l-4 4" /></Icon>;
export const Bluetooth = () => <Icon><path d="m7 7 10 10-5 4V3l5 4L7 17" /></Icon>;
export const Headphones = () => <Icon><path d="M4 15v-3a8 8 0 0 1 16 0v3M4 15h3v5H5a1 1 0 0 1-1-1v-4ZM20 15h-3v5h2a1 1 0 0 0 1-1v-4Z" /></Icon>;
export const Copy = () => <Icon><rect x="9" y="9" width="11" height="11" rx="2" /><path d="M5 15V6a2 2 0 0 1 2-2h9" /></Icon>;
export const UserPlus = () => <Icon><circle cx="10" cy="8" r="3.5" /><path d="M3 20a7 7 0 0 1 14 0M19 8v6M16 11h6" /></Icon>;
export const Check = () => <Icon><path d="m5 12 5 5 9-10" /></Icon>;
export const X = () => <Icon><path d="m6 6 12 12M18 6 6 18" /></Icon>;
export const Music = () => <Icon><path d="M9 18V6l10-2v12" /><circle cx="6.5" cy="18" r="2.5" /><circle cx="16.5" cy="16" r="2.5" /></Icon>;

export const ArrowUp = () => <Icon><path d="M12 19V5M6 11l6-6 6 6" /></Icon>;
export const ArrowDown = () => <Icon><path d="M12 5v14M6 13l6 6 6-6" /></Icon>;

export const Logo = () => (
  <svg viewBox="0 0 48 48" aria-hidden="true">
    <rect width="48" height="48" rx="13" fill="#FF6A1A" />
    <path d="M9 17c8-6 14 6 22 0M9 25c8-6 14 6 22 0M9 33c8-6 14 6 22 0" fill="none" stroke="#160800" stroke-width="3.6" stroke-linecap="round" />
    <circle cx="37" cy="17" r="2.6" fill="#160800" />
  </svg>
);
