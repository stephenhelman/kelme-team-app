"use client";

import { useRef, useState } from "react";

export function BrandVideo() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [playing, setPlaying] = useState(false);

  function handlePlay() {
    setPlaying(true);
    videoRef.current?.play();
  }

  return (
    <section className="relative aspect-video w-full overflow-hidden bg-ink">
      <video
        ref={videoRef}
        src="/brand-video.mp4"
        poster="/video-placeholder.webp"
        controls={playing}
        playsInline
        className="h-full w-full object-cover"
      />
      {!playing && (
        <button
          type="button"
          onClick={handlePlay}
          aria-label="Play brand video"
          className="absolute inset-0 flex items-center justify-center bg-black/20 transition-colors hover:bg-black/10"
        >
          <span className="flex h-16 w-16 items-center justify-center rounded-full bg-white/90 sm:h-20 sm:w-20">
            <svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor" className="ml-1 text-ink">
              <path d="M8 5v14l11-7z" />
            </svg>
          </span>
        </button>
      )}
    </section>
  );
}
