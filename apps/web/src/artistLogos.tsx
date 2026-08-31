import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { post } from "./api";

/**
 * An artist's logo beside their name, anywhere their name is written.
 *
 * The catalog views carry `artist: { id, name }` and nothing else, and activity
 * and now-playing carry a bare string, so there is no artwork to render from
 * what a page already holds. Rather than thread a logo through every shape
 * `catalog.ts` builds, the marks ask for themselves: each one registers its
 * artist's name, the names collected in one tick go to the API as a single
 * batch, and answers land in a cache that outlives the view that asked.
 *
 * Nothing here waits on the answer and nothing reserves room for it. A logo is
 * absent far more often than present — no fanart.tv key, an artist nobody drew,
 * the first read after new music lands — so the name in text beside the mark is
 * the surface, and the mark is what may or may not arrive next to it.
 */

/** The API's `normalized`, which is what keys the artwork rows it answers with. */
export function normalized(value: string): string {
  return value.normalize("NFKD").toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

type LogoLookup = {
  logos: ReadonlyMap<string, string | null>;
  want: (key: string, name: string) => void;
};

const ArtistLogoLookup = createContext<LogoLookup>({ logos: new Map(), want: () => {} });

export function ArtistLogoProvider({ children }: { children: ReactNode }) {
  const [logos, setLogos] = useState<ReadonlyMap<string, string | null>>(new Map());
  // Every name already asked about, answered or not. A miss is an answer worth
  // keeping: an artist with no logo must not be asked about once per row.
  const asked = useRef(new Set<string>());
  const pending = useRef(new Map<string, string>());
  const timer = useRef<number | null>(null);

  const want = useCallback((key: string, name: string) => {
    if (!key || asked.current.has(key)) return;
    asked.current.add(key);
    pending.current.set(key, name);
    // Collected across one tick rather than sent per mark: a track table mounts
    // a mark per row and each of them registers in its own effect.
    if (timer.current !== null) return;
    timer.current = window.setTimeout(() => {
      timer.current = null;
      const batch = [...pending.current];
      pending.current.clear();
      if (!batch.length) return;
      void post<{ logos: Record<string, string | null> }>("/api/artists/logos", { names: batch.map(([, name]) => name) })
        .then((body) => setLogos((current) => new Map([...current, ...Object.entries(body.logos)])))
        // A failed lookup renders as the ordinary case — the name is on screen
        // in text either way — and is forgotten, so a later view may try again.
        .catch(() => { for (const [key] of batch) asked.current.delete(key); });
    }, 0);
  }, []);

  useEffect(() => () => { if (timer.current !== null) window.clearTimeout(timer.current); }, []);

  return <ArtistLogoLookup.Provider value={useMemo(() => ({ logos, want }), [logos, want])}>{children}</ArtistLogoLookup.Provider>;
}

export function useArtistLogo(name: string): string | null {
  const { logos, want } = useContext(ArtistLogoLookup);
  const key = normalized(name);
  useEffect(() => { want(key, name); }, [want, key, name]);
  return logos.get(key) ?? null;
}

/**
 * A logo that has resolved, and the handler that forgets it if the bytes fail.
 * A fresh URL clears the failure, so replacing a logo is not hidden behind the
 * broken one.
 */
function useLettering(name: string) {
  const logo = useArtistLogo(name);
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [logo]);
  return { logo: failed ? null : logo, onError: () => setFailed(true) };
}

/**
 * One artist's logo set at the height of the line it sits in, or nothing at all.
 *
 * Sized by the line rather than by itself, for the reason the artist row's frame
 * exists: fanart.tv logos share an 800x310 canvas and fill wildly different
 * fractions of it, so a mark left to its own dimensions would push one row of a
 * list taller than the next. Decorative, because every caller keeps the name in
 * text beside it.
 */
export function ArtistLettering({ name, className = "" }: { name: string; className?: string }) {
  const { logo, onError } = useLettering(name);
  if (!logo) return null;
  return <img className={`artist-lettering ${className}`} src={logo} alt="" loading="lazy" onError={onError} />;
}

/**
 * The logo standing in for the name, and the name itself where there is none.
 *
 * The opposite of the component above, and the album feed is the only list that
 * reads this way: nothing else in its row repeats the artist, so a mark beside
 * the name would be the same word twice. It carries the name as its alt text
 * for that reason — here the logo *is* the name, the way it is on the artist's
 * own page, rather than a decoration next to it.
 */
export function ArtistName({ name, className = "" }: { name: string; className?: string }) {
  const { logo, onError } = useLettering(name);
  if (!logo) return <>{name}</>;
  return <img className={`artist-lettering ${className}`} src={logo} alt={name} loading="lazy" onError={onError} />;
}
