import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { Track } from "./types";

type PlayerState = {
  queue: Track[];
  index: number;
  current?: Track;
  playing: boolean;
  error: string;
  play: (tracks: Track[], index?: number) => void;
  toggle: () => void;
  next: () => void;
  previous: () => void;
};

const PlayerContext = createContext<PlayerState | null>(null);

export function PlayerProvider({ children }: { children: ReactNode }) {
  const [queue, setQueue] = useState<Track[]>([]);
  const [index, setIndex] = useState(-1);
  const [playing, setPlaying] = useState(false);
  const [error, setError] = useState("");
  const audio = useRef<HTMLAudioElement | null>(null);
  const queueLength = useRef(0);
  queueLength.current = queue.length;
  const current = index >= 0 ? queue[index] : undefined;

  useEffect(() => {
    if (!audio.current) audio.current = new Audio();
    const element = audio.current;
    element.preload = "auto";
    const onEnded = () => setIndex((value) => {
      if (value < queueLength.current - 1) return value + 1;
      setPlaying(false);
      return value;
    });
    const onPlay = () => setPlaying(true);
    const onPause = () => setPlaying(false);
    const onError = () => {
      const detail = element.error?.message;
      setError(detail ? `Playback failed: ${detail}` : "Playback failed. The audio stream could not be loaded.");
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
    if (!current || !audio.current) return;
    if (audio.current.dataset.trackId === current.id) return;
    audio.current.dataset.trackId = current.id;
    audio.current.src = current.streamUrl;
    setError("");
    audio.current.play().catch((issue) => {
      setError(issue instanceof Error ? `Playback failed: ${issue.message}` : "Playback was blocked by the browser.");
      setPlaying(false);
    });
  }, [current?.id]);

  const value = useMemo<PlayerState>(() => ({
    queue,
    index,
    current,
    playing,
    error,
    play: (tracks, start = 0) => {
      const track = tracks[start];
      if (!track) return;
      setQueue(tracks);
      setIndex(start);
      setError("");
      if (!audio.current) return;
      audio.current.dataset.trackId = track.id;
      audio.current.src = track.streamUrl;
      audio.current.play().catch((issue) => {
        setError(issue instanceof Error ? `Playback failed: ${issue.message}` : "Playback was blocked by the browser.");
        setPlaying(false);
      });
    },
    toggle: () => {
      if (!audio.current || !current) return;
      if (audio.current.paused) {
        setError("");
        void audio.current.play().catch((issue) => {
          setError(issue instanceof Error ? `Playback failed: ${issue.message}` : "Playback was blocked by the browser.");
          setPlaying(false);
        });
      } else audio.current.pause();
    },
    next: () => setIndex((value) => Math.min(queue.length - 1, value + 1)),
    previous: () => {
      if (audio.current && audio.current.currentTime > 3) audio.current.currentTime = 0;
      else setIndex((value) => Math.max(0, value - 1));
    }
  }), [queue, index, current, playing, error]);

  return <PlayerContext.Provider value={value}>{children}<PlayerBar audio={audio} /></PlayerContext.Provider>;
}

export function usePlayer() {
  const context = useContext(PlayerContext);
  if (!context) throw new Error("PlayerProvider is missing");
  return context;
}

function PlayerBar({ audio }: { audio: React.RefObject<HTMLAudioElement | null> }) {
  const player = usePlayer();
  const [elapsed, setElapsed] = useState(0);
  const [queueOpen, setQueueOpen] = useState(false);

  useEffect(() => {
    const element = audio.current;
    if (!element) return;
    const update = () => setElapsed(element.currentTime);
    element.addEventListener("timeupdate", update);
    return () => element.removeEventListener("timeupdate", update);
  }, [audio, player.current?.id]);

  if (!player.current) return null;
  const duration = player.current.duration || audio.current?.duration || 0;
  return (
    <>
      {queueOpen && (
        <aside className="queue-panel">
          <div className="queue-head"><strong>Up next</strong><button className="icon-button" onClick={() => setQueueOpen(false)}>×</button></div>
          {player.queue.map((track, index) => (
            <button className={`queue-item ${index === player.index ? "active" : ""}`} key={track.id} onClick={() => player.play(player.queue, index)}>
              <span>{index + 1}</span><span><strong>{track.title}</strong><small>{track.artist.name}</small></span>
            </button>
          ))}
        </aside>
      )}
      <footer className="player-bar">
        <div className="player-track">
          <Artwork src={player.current.album.artworkUrl} label={player.current.album.title} />
          <span><strong>{player.current.title}</strong><small>{player.current.artist.name} · {player.current.album.title}</small></span>
        </div>
        <div className="player-controls">
          <div><button aria-label="Previous" onClick={player.previous}>‹</button><button className="play-round" aria-label={player.playing ? "Pause" : "Play"} onClick={player.toggle}>{player.playing ? "Ⅱ" : "▶"}</button><button aria-label="Next" onClick={player.next}>›</button></div>
          {player.error ? <p className="player-error" title={player.error}>{player.error}</p> : <label><time>{formatTime(elapsed)}</time><input type="range" min="0" max={duration || 1} value={Math.min(elapsed, duration || 1)} onChange={(event) => { if (audio.current) audio.current.currentTime = Number(event.target.value); }} /><time>{formatTime(duration)}</time></label>}
        </div>
        <button className="queue-toggle" onClick={() => setQueueOpen((open) => !open)}>Queue <span>{player.queue.length}</span></button>
      </footer>
    </>
  );
}

function Artwork({ src, label }: { src: string; label: string }) {
  const [failed, setFailed] = useState(false);
  return failed ? <span className="mini-art fallback">{label.slice(0, 1)}</span> : <img className="mini-art" src={src} alt="" onError={() => setFailed(true)} />;
}

export function formatTime(seconds: number) {
  if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${String(Math.floor(seconds % 60)).padStart(2, "0")}`;
}
