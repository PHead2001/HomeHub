'use client';

import { useState, type ReactNode } from 'react';

/**
 * The photo band at the top of asset and vehicle cards (H30). A blurred, scaled
 * copy of the photo covers the fixed 80 px band and the sharp photo sits on top
 * uncropped (`object-contain`), so portrait and landscape shots both read. With
 * no photo, or when it fails to load, the band shows `fallback` (the brand logo
 * or category icon) on a token gradient. The height is fixed, so nothing shifts
 * when the image loads. Decorative: the card's text names the item.
 */
export function PhotoBand({ url, fallback, kind }: { url?: string | null; fallback: ReactNode; kind: 'asset' | 'vehicle' }) {
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const shown = url && url !== failedUrl ? url : null;
  const state = shown ? 'image' : 'fallback';
  return (
    <div
      aria-hidden
      className="relative h-20 w-full shrink-0 overflow-hidden bg-muted"
      {...(kind === 'asset' ? { 'data-asset-photo': state } : { 'data-vehicle-photo': state })}
    >
      {shown ? (
        <>
          {/* eslint-disable-next-line @next/next/no-img-element -- user-uploaded Storage URL; no fixed remote pattern */}
          <img src={shown} alt="" className="absolute inset-0 h-full w-full scale-110 object-cover opacity-60 blur-xl" loading="lazy" decoding="async" />
          {/* eslint-disable-next-line @next/next/no-img-element -- user-uploaded Storage URL; no fixed remote pattern */}
          <img
            src={shown}
            alt=""
            className="relative h-full w-full object-contain"
            loading="lazy"
            decoding="async"
            onError={() => setFailedUrl(shown)}
          />
        </>
      ) : (
        <div className="flex h-full w-full items-center justify-center bg-gradient-to-br from-primary/20 via-muted to-secondary text-primary">
          {fallback}
        </div>
      )}
    </div>
  );
}
