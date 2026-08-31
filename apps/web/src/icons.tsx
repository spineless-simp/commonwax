import type { ReactNode, SVGProps } from "react";

export type IconName =
  | "home" | "albums" | "artists" | "tracks" | "request" | "activity" | "people" | "hidden"
  | "search" | "add" | "logout" | "play" | "pause" | "previous" | "next" | "queue"
  | "close" | "upload" | "music" | "invite" | "arrow" | "chevron" | "menu"
  | "server" | "restart" | "warning" | "block"   | "skip-back" | "skip-forward" | "stop" | "shuffle"
  | "volume" | "volume-mute" | "view-feed" | "view-grid"
  | "settings";

export function Icon({ name, ...props }: SVGProps<SVGSVGElement> & { name: IconName }) {
  const paths: Record<IconName, ReactNode> = {
    home: <><path d="m3 10 9-7 9 7"/><path d="M5 9v12h14V9"/><path d="M9 21v-7h6v7"/></>,
    albums: <><rect x="3" y="3" width="18" height="18" rx="1"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1"/></>,
    artists: <><circle cx="9" cy="8" r="4"/><path d="M3 21v-2a6 6 0 0 1 12 0v2"/><path d="M18 8v9"/><path d="m18 8 3-1v8"/><circle cx="16.5" cy="17.5" r="1.5"/><circle cx="19.5" cy="15.5" r="1.5"/></>,
    tracks: <><path d="M9 6h12M9 12h12M9 18h12"/><circle cx="4" cy="6" r="1"/><circle cx="4" cy="12" r="1"/><circle cx="4" cy="18" r="1"/></>,
    request: <><path d="M21 15a4 4 0 0 1-4 4H8l-5 3V7a4 4 0 0 1 4-4h10a4 4 0 0 1 4 4z"/><path d="M12 7v8M8 11h8"/></>,
    activity: <><path d="M4 19V9M10 19V5M16 19v-7M22 19V3"/></>,
    people: <><circle cx="9" cy="8" r="3"/><path d="M3 20v-1a6 6 0 0 1 12 0v1"/><circle cx="18" cy="9" r="2"/><path d="M16 15a5 5 0 0 1 5 5"/></>,
    hidden: <><path d="M3 3l18 18"/><path d="M10.6 10.7a2 2 0 0 0 2.7 2.7"/><path d="M9.9 4.2A10.8 10.8 0 0 1 21 12a12 12 0 0 1-2.4 3.5M6.6 6.6A12.8 12.8 0 0 0 3 12a10.9 10.9 0 0 0 8.3 7.8"/></>,
    search: <><circle cx="11" cy="11" r="7"/><path d="m20 20-4-4"/></>,
    add: <><path d="M12 5v14M5 12h14"/></>,
    logout: <><path d="M10 17l5-5-5-5M15 12H3"/><path d="M14 3h7v18h-7"/></>,
    play: <path d="m8 5 11 7-11 7z" fill="currentColor" stroke="none"/>,
    pause: <><path d="M9 5v14M15 5v14"/></>,
    previous: <><path d="M6 5v14M18 6l-9 6 9 6z"/></>,
    next: <><path d="M18 5v14M6 6l9 6-9 6z"/></>,
    queue: <><path d="M4 6h12M4 12h12M4 18h8"/><path d="m17 16 4 2-4 2z"/></>,
    close: <path d="M5 5l14 14M19 5 5 19"/>,
    upload: <><path d="M12 16V3M7 8l5-5 5 5"/><path d="M4 14v7h16v-7"/></>,
    music: <><path d="M9 18V5l11-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="17" cy="16" r="3"/></>,
    invite: <><circle cx="9" cy="8" r="3"/><path d="M3 20v-1a6 6 0 0 1 12 0v1M19 8v6M16 11h6"/></>,
    arrow: <><path d="M5 12h14M14 7l5 5-5 5"/></>,
    chevron: <path d="m7 9 5 5 5-5"/>,
    menu: <><path d="M5 7h14M5 12h14M5 17h14"/></>,
    server: <><rect x="3" y="4" width="18" height="7" rx="1.5"/><rect x="3" y="13" width="18" height="7" rx="1.5"/><path d="M7 7.5h.01M7 16.5h.01"/></>,
    restart: <><path d="M20 12a8 8 0 1 1-2.6-5.9"/><path d="M20 3v5h-5"/></>,
    warning: <><path d="M12 3.8 2.9 19.5h18.2z"/><path d="M12 10v4M12 17h.01"/></>,
    block: <><circle cx="12" cy="12" r="9"/><path d="m5.6 5.6 12.8 12.8"/></>,
    shuffle: <><path d="M16 3h5v5"/><path d="M4 20L21 3"/><path d="M21 16v5h-5"/><path d="M15 15l6 6"/><path d="M4 4l5 5"/></>,
    "skip-back": <><path d="M20 5v14"/><path d="M4 12a8 8 0 0 1 14-5.3"/><path d="M4 12a8 8 0 0 0 14 5.3"/></>,
    "skip-forward": <><path d="M4 5v14"/><path d="M20 12a8 8 0 0 0-14-5.3"/><path d="M20 12a8 8 0 0 1-14 5.3"/></>,
    stop: <rect x="6" y="6" width="12" height="12" rx="1" fill="currentColor" stroke="none"/>,
    volume: <><path d="M11 5 6 9H2v6h4l5 4z"/><path d="M15.5 8.5a5 5 0 0 1 0 7"/><path d="M19 5a9 9 0 0 1 0 14"/></>,
    "volume-mute": <><path d="M11 5 6 9H2v6h4l5 4z"/><path d="m17 9 5 5M22 9l-5 5"/></>,
    "view-feed": <><path d="M3 5h18M3 12h18M3 19h18"/></>,
    "view-grid": <><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></>,
    settings: <><path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/></>
  };
  return <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" {...props}>{paths[name]}</svg>;
}
