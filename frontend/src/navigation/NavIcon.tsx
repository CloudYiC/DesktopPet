/** Code-native outline icons: no icon font, network request or raster scaling. */
export type NavIconName = 'home' | 'data' | 'network' | 'system' | 'file-conversion' | 'today' | 'all' | 'status' | 'settings';

export function NavIcon({ name }: { name: NavIconName }) {
  return <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false" data-nav-icon={name}>
    {name === 'home' && <><path d="m3 10 9-7 9 7v10a1 1 0 0 1-1 1h-5v-7H9v7H4a1 1 0 0 1-1-1Z" /><path d="M9 21v-7h6v7" /></>}
    {name === 'data' && <><ellipse cx="12" cy="5" rx="8" ry="3" /><path d="M4 5v14c0 1.7 3.6 3 8 3s8-1.3 8-3V5M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3" /></>}
    {name === 'network' && <><circle cx="12" cy="12" r="9" /><ellipse cx="12" cy="12" rx="4" ry="9" /><path d="M3 12h18M5 6.5h14M5 17.5h14" /></>}
    {name === 'system' && <path d="M21 5.8a6 6 0 0 1-7.6 7.6l-6.7 6.7a2.2 2.2 0 0 1-3.1-3.1l6.7-6.7A6 6 0 0 1 18 2.7l-4.1 4.1 3.2 3.2Z" />}
    {name === 'file-conversion' && <path d="M3 20a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h6l2 3h10a1 1 0 0 1 1 1v11a1 1 0 0 1-1 1Z" />}
    {name === 'today' && <><rect x="3" y="5" width="18" height="16" rx="2" /><path d="M7 2v6M17 2v6M3 10h18M7 14h1M12 14h1M7 18h1M12 18h1M17 14h1" /></>}
    {name === 'all' && <><path d="M8 5h13M8 12h13M8 19h13M3 5h.1M3 12h.1M3 19h.1" /><path d="M2 12h2M3 11v2" /></>}
    {name === 'status' && <><path d="M4 21V11M10 21V4M16 21V8M22 21V1" /></>}
    {name === 'settings' && <><path d="m9 3 .7-1h4.6l.7 1 .3 2 1.6.9 1.9-.7 1.2.1 2.3 4-.5 1.2-1.5 1.3v1.8l1.5 1.3.5 1.2-2.3 4-1.2.1-1.9-.7-1.6.9-.3 2-.7 1H9.7l-.7-1-.3-2-1.6-.9-1.9.7-1.2-.1-2.3-4 .5-1.2L3.7 13v-1.8l-1.5-1.3-.5-1.2 2.3-4 1.2-.1 1.9.7 1.6-.9Z" transform="translate(0 -.3) scale(1 .98)" /><circle cx="12" cy="12" r="3.4" /></>}
  </svg>;
}
