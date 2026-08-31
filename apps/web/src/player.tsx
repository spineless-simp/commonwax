import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { AnimatePresence, motion, useAnimationFrame, useMotionValue } from "motion/react";
import { api } from "./api";
import { ArtistLettering, useArtistLogo } from "./artistLogos";
import { Icon } from "./icons";
import type { Track } from "./types";

/**
 * Comfortably inside the two-minute window the API treats a presence row as
 * fresh, so one dropped heartbeat does not make a listener flicker away.
 */
const PRESENCE_HEARTBEAT_MS = 45_000;

type PlayerState = {
  queue: Track[];
  index: number;
  current?: Track;
  playing: boolean;
  error: string;
  /** The single audio element, for the one component that draws its timeline. */
  audio: React.RefObject<HTMLAudioElement | null>;
  /** Whether there is a later track. Previous is always live — it restarts this one. */
  hasNext: boolean;
  play: (tracks: Track[], index?: number) => void;
  toggle: () => void;
  next: () => void;
  previous: () => void;
  stop: () => void;
  shuffle: () => void;
  shuffleAll: () => void;
};

function playbackFailure(issue?: unknown) {
  const message = issue instanceof Error ? issue.message.toLocaleLowerCase() : "";
  const name = issue instanceof DOMException ? issue.name : "";
  if (name === "NotAllowedError" || message.includes("not allowed") || message.includes("gesture") || message.includes("blocked")) {
    return "Playback was blocked. Tap Play to start.";
  }
  return "Playback failed. Check your connection and try again.";
}

function shuffleArray<T>(array: T[]): T[] {
  const result = [...array];
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

const PlayerContext = createContext<PlayerState | null>(null);

export function PlayerProvider({ children }: { children: ReactNode }) {
  const [queue, setQueue] = useState<Track[]>([]);
  const [index, setIndex] = useState(-1);
  const [playing, setPlaying] = useState(false);
  const [error, setError] = useState("");
  const audio = useRef<HTMLAudioElement | null>(null);
  const reportedPresence = useRef(false);
  const queueLength = useRef(0);
  const fetchTracksAndShuffleRef = useRef<() => void>(() => {});
  queueLength.current = queue.length;
  const current = index >= 0 ? queue[index] : undefined;

  useEffect(() => {
    if (!audio.current) audio.current = new Audio();
    const element = audio.current;
    element.preload = "auto";
    // Restore volume from localStorage if volume memory is enabled
    if (localStorage.getItem("cw:volume-memory") !== "false") {
      const savedVolume = localStorage.getItem("cw:volume");
      if (savedVolume !== null) element.volume = Number(savedVolume);
      const savedMuted = localStorage.getItem("cw:muted");
      if (savedMuted === "true") element.volume = 0;
    }
    const onEnded = () => {
      // Respect autoplay setting
      if (localStorage.getItem("cw:autoplay") === "false") {
        setPlaying(false);
        return;
      }
      setIndex((value) => {
        if (value < queueLength.current - 1) return value + 1;
        // Queue ended — check if continuous playing is enabled
        if (localStorage.getItem("cw:continue-playing") === "true") {
          fetchTracksAndShuffleRef.current();
          return value;
        }
        setPlaying(false);
        return value;
      });
    };
    const onPlay = () => setPlaying(true);
    const onPause = () => setPlaying(false);
    const onError = () => {
      setError("Playback failed. Try another track or check your connection.");
      setPlaying(false);
    };
    element.addEventListener("ended", onEnded);
    element.addEventListener("play", onPlay);
    element.addEventListener("pause", onPause);
    element.addEventListener("error", onError);
    return () => {
      element.removeEventListener("ended", onEnded);
      element.removeEventListener("play", onPlay);
      element.removeEventListener("pause", onPause);
      element.removeEventListener("error", onError);
      element.pause();
    };
  }, []);

  useEffect(() => {
    if (!current?.streamUrl || !audio.current) return;
    if (audio.current.dataset.trackId === current.id) return;
    audio.current.dataset.trackId = current.id;
    audio.current.src = current.streamUrl;
    setError("");
    audio.current.play().catch((issue) => {
      setError(playbackFailure(issue));
      setPlaying(false);
    });
  }, [current?.id]);

  // Listening presence for the library overview. Nothing else reports it, so it
  // is written only while audio is genuinely playing and withdrawn as soon as it
  // is not; the heartbeat exists so a tab that simply vanishes expires server-side.
  useEffect(() => {
    const trackId = playing ? current?.id : undefined;
    if (!trackId) {
      if (!reportedPresence.current) return;
      reportedPresence.current = false;
      void api("/api/now-playing", { method: "DELETE" }).catch(() => undefined);
      return;
    }
    const report = () => {
      reportedPresence.current = true;
      void api("/api/now-playing", { method: "PUT", body: JSON.stringify({ trackId }) }).catch(() => undefined);
    };
    report();
    const beat = window.setInterval(report, PRESENCE_HEARTBEAT_MS);
    return () => window.clearInterval(beat);
  }, [current?.id, playing]);

  // The lock screen, headphone buttons, and a car head unit all drive the same
  // four controls the player bar does. Without this they reach nothing, and a
  // phone in a pocket has no way to skip a track.
  useEffect(() => {
    const session = navigator.mediaSession;
    if (!session) return;
    if (!current) {
      session.metadata = null;
      session.playbackState = "none";
      return;
    }
    session.metadata = new MediaMetadata({
      title: current.title,
      artist: current.artist.name,
      album: current.album.title,
      artwork: current.album.artworkUrl ? [{ src: current.album.artworkUrl }] : []
    });
    session.playbackState = playing ? "playing" : "paused";
  }, [current, playing]);

  useEffect(() => {
    const session = navigator.mediaSession;
    if (!session) return;
    const element = audio.current;
    const handlers: [MediaSessionAction, MediaSessionActionHandler][] = [
      ["play", () => void element?.play().catch(() => undefined)],
      ["pause", () => element?.pause()],
      ["previoustrack", () => {
        if (element && element.currentTime > 3) element.currentTime = 0;
        else setIndex((value) => Math.max(0, value - 1));
      }],
      ["nexttrack", () => setIndex((value) => Math.min(queueLength.current - 1, value + 1))],
      ["seekto", (details) => { if (element && details.seekTime !== undefined) element.currentTime = details.seekTime; }],
      ["stop", () => { if (element) { element.pause(); element.currentTime = 0; } }]
    ];
    for (const [action, handler] of handlers) {
      // A browser that does not know an action throws rather than ignoring it.
      try { session.setActionHandler(action, handler); } catch { /* unsupported here */ }
    }
    return () => {
      for (const [action] of handlers) {
        try { session.setActionHandler(action, null); } catch { /* unsupported here */ }
      }
    };
  }, []);

  useEffect(() => {
    // A closed tab would otherwise keep reporting until its row goes stale.
    const withdraw = () => {
      if (!reportedPresence.current) return;
      reportedPresence.current = false;
      fetch("/api/now-playing", { method: "DELETE", credentials: "same-origin", keepalive: true }).catch(() => undefined);
    };
    window.addEventListener("pagehide", withdraw);
    return () => window.removeEventListener("pagehide", withdraw);
  }, []);

  const value = useMemo<PlayerState>(() => {
    function fetchTracksAndShuffle() {
      api<{ tracks: Track[] }>("/api/tracks").then(({ tracks }) => {
        const playable = tracks.filter((track) => track.available && Boolean(track.streamUrl));
        if (!playable.length) { setPlaying(false); return; }
        const shuffled = shuffleArray(playable);
        setQueue(shuffled);
        setIndex(0);
        setError("");
        if (audio.current) {
          audio.current.dataset.trackId = shuffled[0].id;
          audio.current.src = shuffled[0].streamUrl!;
          audio.current.play().catch((issue) => { setError(playbackFailure(issue)); setPlaying(false); });
        }
      }).catch(() => { setPlaying(false); });
    }
    fetchTracksAndShuffleRef.current = fetchTracksAndShuffle;

    return ({
    queue,
    index,
    current,
    playing,
    error,
    audio,
    play: (tracks, start = 0) => {
      const requested = tracks[start];
      const playable = tracks.filter((track) => track.available && Boolean(track.streamUrl));
      if (!playable.length) return;
      const requestedIndex = requested?.available && requested.streamUrl
        ? playable.findIndex((track) => track.id === requested.id)
        : -1;
      const playableIndex = requestedIndex >= 0 ? requestedIndex : 0;
      const track = playable[playableIndex];
      // Respect queue behavior: append or replace
      const appendMode = localStorage.getItem("cw:queue-behavior") === "append";
      if (appendMode && queue.length > 0) {
        const existingIds = new Set(queue.map((t) => t.id));
        const newTracks = playable.filter((t) => !existingIds.has(t.id));
        if (newTracks.length) {
          const startIndex = queue.length;
          setQueue((prev) => [...prev, ...newTracks]);
          setIndex(startIndex);
        } else {
          // All tracks already in queue, just jump to the requested one
          const existingIndex = queue.findIndex((t) => t.id === track.id);
          if (existingIndex >= 0) setIndex(existingIndex);
        }
      } else {
        setQueue(playable);
        setIndex(playableIndex);
      }
      setError("");
      if (!audio.current) return;
      audio.current.dataset.trackId = track.id;
      audio.current.src = track.streamUrl!;
      audio.current.play().catch((issue) => {
        setError(playbackFailure(issue));
        setPlaying(false);
      });
    },
    toggle: () => {
      if (!audio.current || !current) return;
      if (audio.current.paused) {
        setError("");
        void audio.current.play().catch((issue) => {
          setError(playbackFailure(issue));
          setPlaying(false);
        });
      } else audio.current.pause();
    },
    hasNext: index >= 0 && index < queue.length - 1,
    next: () => setIndex((value) => Math.min(queue.length - 1, value + 1)),
    previous: () => {
      if (audio.current && audio.current.currentTime > 3) audio.current.currentTime = 0;
      else setIndex((value) => Math.max(0, value - 1));
    },
    stop: () => {
      if (audio.current) {
        audio.current.pause();
        audio.current.currentTime = 0;
      }
      setQueue([]);
      setIndex(-1);
      setPlaying(false);
      setError("");
      if (reportedPresence.current) {
        reportedPresence.current = false;
        void api("/api/now-playing", { method: "DELETE" }).catch(() => undefined);
      }
    },
    shuffle: () => {
      if (!queue.length) { fetchTracksAndShuffle(); return; }
      const currentTrack = index >= 0 ? queue[index] : null;
      const rest = queue.filter((_, i) => i !== index);
      const shuffledRest = shuffleArray(rest);
      const newQueue = currentTrack ? [currentTrack, ...shuffledRest] : shuffledRest;
      setQueue(newQueue);
      setIndex(currentTrack ? 0 : -1);
      setError("");
      if (currentTrack && audio.current) {
        audio.current.dataset.trackId = currentTrack.id;
        audio.current.src = currentTrack.streamUrl!;
        audio.current.play().catch((issue) => { setError(playbackFailure(issue)); setPlaying(false); });
      }
    },
    shuffleAll: () => { fetchTracksAndShuffle(); },
  });}, [queue, index, current, playing, error]);


  // The bar is not rendered here. Playback state is global, but the fixed player
  // owns the bottom horizon of the listening frame alone — it has no business
  // sitting over sign-in, an invitation, or the arrival screen, where an idle
  // "Nothing playing" strip is noise in front of someone who has not arrived yet.
  return <PlayerContext.Provider value={value}>{children}</PlayerContext.Provider>;
}

export function usePlayer() {
  const context = useContext(PlayerContext);
  if (!context) throw new Error("PlayerProvider is missing");
  return context;
}

export function PlayerBar() {
  const player = usePlayer();
  const audio = player.audio;
  const [elapsed, setElapsed] = useState(0);
  const [volume, setVolume] = useState(() => {
    if (localStorage.getItem("cw:volume-memory") !== "false") {
      const saved = localStorage.getItem("cw:volume");
      return saved !== null ? Number(saved) : 1;
    }
    return 1;
  });
  const [muted, setMuted] = useState(() => localStorage.getItem("cw:muted") === "true");
  const [queueOpen, setQueueOpen] = useState(false);
  const [skipInterval, setSkipInterval] = useState(() => Number(localStorage.getItem("cw:skip-interval")) || 10);
  const progress = useMotionValue(0);
  const labelUpdate = useRef(0);
  const queueButton = useRef<HTMLButtonElement>(null);
  const queuePanel = useRef<HTMLElement>(null);
  const artistLogo = useArtistLogo(player.current?.artist.name ?? "");

  useEffect(() => {
    setElapsed(0);
    progress.set(0);
  }, [player.current?.id, progress]);

  useEffect(() => {
    if (!queueOpen) return;
    const panel = queuePanel.current;
    window.requestAnimationFrame(() => panel?.querySelector<HTMLButtonElement>("button")?.focus());
    return () => {
      if (document.activeElement === document.body || panel?.contains(document.activeElement)) queueButton.current?.focus();
    };
  }, [queueOpen]);

  // Only while audio is actually moving. This runs every animation frame for
  // the life of the app otherwise, which on a phone is a wakeup sixty times a
  // second to read a timestamp that is not changing.
  useAnimationFrame((time) => {
    if (!player.playing) return;
    const element = audio.current;
    const duration = player.current?.duration || element?.duration || 0;
    const currentTime = element?.currentTime || 0;
    progress.set(duration > 0 ? Math.min(1, currentTime / duration) : 0);
    if (time - labelUpdate.current >= 200) {
      labelUpdate.current = time;
      setElapsed(currentTime);
    }
  });

  const duration = player.current?.duration || audio.current?.duration || 0;
  function closeQueue() {
    setQueueOpen(false);
    window.requestAnimationFrame(() => queueButton.current?.focus());
  }
  function seek(value: number) {
    if (!audio.current) return;
    audio.current.currentTime = value;
    setElapsed(value);
    progress.set(duration > 0 ? Math.min(1, value / duration) : 0);
  }
  function handleVolumeChange(value: number) {
    if (!audio.current) return;
    audio.current.volume = value;
    setVolume(value);
    if (localStorage.getItem("cw:volume-memory") !== "false") {
      localStorage.setItem("cw:volume", String(value));
    }
    if (value === 0) setMuted(true);
    else if (muted) setMuted(false);
  }
  function toggleMute() {
    if (!audio.current) return;
    if (muted) { audio.current.volume = volume || 1; setMuted(false); if (localStorage.getItem("cw:volume-memory") !== "false") localStorage.setItem("cw:muted", "false"); }
    else { audio.current.volume = 0; setMuted(true); if (localStorage.getItem("cw:volume-memory") !== "false") localStorage.setItem("cw:muted", "true"); }
  }

 return (
    <>
      <AnimatePresence>
        {queueOpen && player.current && (
          <motion.aside ref={queuePanel} className="queue-panel" tabIndex={-1} onKeyDown={(event) => {
            if (event.key === "Escape") { event.preventDefault(); closeQueue(); return; }
            if (event.key !== "Tab" || !queuePanel.current) return;
            const elements = Array.from(queuePanel.current.querySelectorAll<HTMLButtonElement>("button:not(:disabled)")).filter((element) => element.getClientRects().length > 0);
            const first = elements[0];
            const last = elements[elements.length - 1];
            if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
            else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
          }} initial={{ opacity: 0, y: 18 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 12 }} transition={{ duration: 0.22, ease: [0.16, 1, 0.3, 1] }}>
            <div className="queue-head"><span><strong>Queue</strong><small>{player.queue.length} {player.queue.length === 1 ? "track" : "tracks"}</small></span><button className="icon-button" onClick={closeQueue} aria-label="Close queue"><Icon name="close" /></button></div>
            {player.queue.map((track, index) => (
              <button className={`queue-item ${index === player.index ? "active" : ""}`} key={track.id} onClick={() => player.play(player.queue, index)}>
                <span>{index === player.index && player.playing ? <Icon name="music" /> : index + 1}</span><span><strong>{track.title}</strong><small><ArtistLettering name={track.artist.name} />{track.artist.name} · {track.suffix?.replace(/^\./, "").toLocaleUpperCase() || "Audio"}</small></span>
              </button>
            ))}
          </motion.aside>
        )}
      </AnimatePresence>
      <footer className={`player-bar${player.current ? "" : " idle"}`}>
          {player.current && <span className="player-backdrop"><img src={player.current.album.artworkUrl ?? ""} alt="" /></span>}
          <label className="player-timeline">
            <span className="timeline-rail" aria-hidden="true"><motion.span className="timeline-progress" style={{ scaleX: progress }} /></span>
            <input type="range" min="0" max={duration || 1} value={Math.min(elapsed, duration || 1)} onChange={(event) => seek(Number(event.target.value))} aria-label="Seek through track" disabled={!player.current} />
          </label>
          <div className="player-track">
            {player.current
              ? <Artwork src={player.current.album.artworkUrl} label={player.current.album.title} />
              : <span className="mini-art idle-art" />}
            <span>
              {player.current
                ? artistLogo
                  ? <small><ArtistLettering name={player.current.artist.name} /></small>
                  : <small>{player.current.artist.name} · {player.current.album.title}</small>
                : <small>Nothing playing</small>}
              {player.current && <strong>{player.current.title}</strong>}
            </span>
          </div>
          <div className="player-controls">
            <p className="player-time"><time>{formatTime(elapsed)}</time><span>/</span><time>{formatTime(duration)}</time></p>
            <button disabled={!player.current} aria-label={`Skip back ${skipInterval} seconds`} onClick={() => seek(Math.max(0, elapsed - skipInterval))}><Icon name="skip-back" /></button>
            <button disabled={!player.current} aria-label="Previous" onClick={player.previous}><Icon name="previous" /></button>
            <button className="play-round" aria-label={player.playing ? "Pause" : "Play"} onClick={player.toggle} disabled={!player.current}><Icon name={player.playing ? "pause" : "play"} /></button>
            <button className="stop-button" aria-label="Stop" onClick={player.stop} disabled={!player.current}><Icon name="stop" /></button>
            <button disabled={!player.hasNext} aria-label="Next" onClick={player.next}><Icon name="next" /></button>
            <button disabled={!player.current} aria-label={`Skip forward ${skipInterval} seconds`} onClick={() => seek(Math.min(duration, elapsed + skipInterval))}><Icon name="skip-forward" /></button>
          </div>
          <div className="player-trailing">
            <button aria-label="Shuffle" onClick={player.shuffle}><Icon name="shuffle" /></button>
            <label className="volume-control">
              <button className="icon-button" onClick={toggleMute} aria-label={muted ? "Unmute" : "Mute"}><Icon name={muted || volume === 0 ? "volume-mute" : "volume"} /></button>
              <input type="range" min="0" max="1" step="0.01" value={muted ? 0 : volume} onChange={(event) => handleVolumeChange(Number(event.target.value))} aria-label="Volume" />
            </label>
            <button ref={queueButton} className={queueOpen ? "active" : ""} onClick={() => setQueueOpen((open) => !open)} aria-label="Queue" aria-expanded={queueOpen}><Icon name="queue" /></button>
          </div>
          {player.error && <p className="player-error" role="alert">{player.error}</p>}
      </footer>
    </>
  );
}

function Artwork({ src, label }: { src: string | null; label: string }) {
  const [failed, setFailed] = useState(false);
  return failed || !src ? <span className="mini-art fallback">{label.slice(0, 1)}</span> : <img className="mini-art" src={src} alt="" onError={() => setFailed(true)} />;
}

export function formatTime(seconds: number) {
  if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${String(Math.floor(seconds % 60)).padStart(2, "0")}`;
}
