'use client';

import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { LoaderCircle, Pause, Play, RotateCcw } from 'lucide-react';

/**
 * A call's recording, in the app's own style rather than the browser's.
 *
 * Play, a bar to seek along, the time, and the speed: HR listening to a call
 * mostly wants to skim it, so 1.5x and 2x are one press away. Only the length
 * is fetched until play is pressed - a page of recordings costs nothing to open.
 */

const SPEEDS = [1, 1.25, 1.5, 2];
const BARS = 64;

function clock(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
  const whole = Math.floor(seconds);
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`;
}

/**
 * The bars behind the seek bar. They are decoration, not the recording's
 * amplitude: reading that would mean downloading and decoding the whole file
 * before the page could be drawn. They are derived from the path so that one
 * recording always draws the same shape and the strip never flickers.
 */
function bars(seed: string): number[] {
  let state = 0;
  for (const character of seed) state = (state * 31 + character.charCodeAt(0)) >>> 0;
  return Array.from({ length: BARS }, () => {
    state = (state * 1_103_515_245 + 12_345) >>> 0;
    return 24 + ((state >>> 8) % 77);
  });
}

export function AudioPlayer({ src, label }: { src: string; label: string }) {
  const audio = useRef<HTMLAudioElement>(null);
  const [playing, setPlaying] = useState(false);
  const [waiting, setWaiting] = useState(false);
  const [failed, setFailed] = useState(false);
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [speed, setSpeed] = useState(1);
  const shape = useMemo(() => bars(src), [src]);

  useEffect(() => {
    if (audio.current) audio.current.playbackRate = speed;
  }, [speed]);

  // An Ogg file reports no length until the browser has looked at its end;
  // until then the bar has nothing to measure against.
  const known = Number.isFinite(duration) && duration > 0;
  const progress = known ? Math.min(100, (time / duration) * 100) : 0;

  const toggle = async () => {
    const element = audio.current;
    if (!element) return;
    if (failed) {
      setFailed(false);
      element.load();
    }
    if (element.paused) {
      setWaiting(true);
      await element.play().catch(() => setFailed(true));
    } else {
      element.pause();
    }
  };

  const ended = known && time >= duration - 0.05 && !playing;

  return (
    <div className={`player${failed ? ' failed' : ''}`}>
      <button
        type="button"
        className="player-play"
        onClick={toggle}
        aria-label={`${failed ? 'Try again' : playing ? 'Pause' : ended ? 'Play again' : 'Play'} ${label}`}
      >
        {failed ? (
          <RotateCcw size={18} strokeWidth={2.2} aria-hidden />
        ) : waiting && !playing ? (
          <LoaderCircle size={18} strokeWidth={2.2} className="player-spin" aria-hidden />
        ) : playing ? (
          <Pause size={18} strokeWidth={2.4} fill="currentColor" aria-hidden />
        ) : (
          <Play size={18} strokeWidth={2.4} fill="currentColor" className="player-play-icon" aria-hidden />
        )}
      </button>

      <div className="player-wave">
        <div className="player-bars" aria-hidden>
          {shape.map((height, index) => (
            <span
              key={index}
              className={(index + 0.5) * (100 / BARS) <= progress ? 'played' : undefined}
              style={{ height: `${height}%` }}
            />
          ))}
        </div>
        <input
          type="range"
          className="player-seek"
          min={0}
          max={known ? duration : 1}
          step={0.1}
          value={known ? time : 0}
          disabled={!known}
          aria-label={`Position in ${label}`}
          aria-valuetext={`${clock(time)} of ${clock(duration)}`}
          style={{ '--progress': `${progress}%` } as CSSProperties}
          onChange={(event) => {
            const at = Number(event.target.value);
            if (audio.current) audio.current.currentTime = at;
            setTime(at);
          }}
        />
      </div>

      <span className="player-time mono">
        {failed ? (
          <span className="player-failed">Could not be played</span>
        ) : (
          <>
            {clock(time)} <span className="player-of">/ {known ? clock(duration) : '–:––'}</span>
          </>
        )}
      </span>

      <button
        type="button"
        className="player-speed mono"
        onClick={() => setSpeed(SPEEDS[(SPEEDS.indexOf(speed) + 1) % SPEEDS.length]!)}
        aria-label={`Playback speed ${speed} times; press to change`}
        title="Playback speed"
      >
        {speed}×
      </button>

      <audio
        ref={audio}
        src={src}
        preload="metadata"
        onLoadedMetadata={(event) => setDuration(event.currentTarget.duration)}
        onDurationChange={(event) => setDuration(event.currentTarget.duration)}
        onTimeUpdate={(event) => setTime(event.currentTarget.currentTime)}
        onPlaying={() => {
          setPlaying(true);
          setWaiting(false);
        }}
        onWaiting={() => setWaiting(true)}
        onPause={() => setPlaying(false)}
        onEnded={() => setPlaying(false)}
        onError={() => {
          setFailed(true);
          setPlaying(false);
          setWaiting(false);
        }}
      />
    </div>
  );
}
