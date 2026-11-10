'use client';

import type { CSSProperties } from 'react';
import {
  BRAND_ACCENT_HEX,
  BRAND_BACKGROUND_HEX,
  LOGO_EAVE_NODES,
  LOGO_HUB_NODE,
  LOGO_ROOF_PATH,
  LOGO_STROKE_WIDTH,
  LOGO_VIEWBOX,
  LOGO_WALLS_PATH,
  LOGO_WINDOWS,
} from '@/components/brand/logo-artwork';
import { crashTime, useCrashRecovery } from '@/components/shell/use-crash-recovery';

// Global error UI replaces the root layout, so it gets no globals.css, fonts,
// theme tokens or providers. Everything here is inline and uses the static brand
// colors (the dark default theme, as on the install splash).
const FOREGROUND = '#f8fafc';
const MUTED = '#94a3b8';

const page: CSSProperties = {
  margin: 0,
  minHeight: '100vh',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  padding: 'max(1.5rem, env(safe-area-inset-top)) 1.5rem max(1.5rem, env(safe-area-inset-bottom))',
  boxSizing: 'border-box',
  background: BRAND_BACKGROUND_HEX,
  color: FOREGROUND,
  fontFamily: 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
  lineHeight: 1.5,
  textAlign: 'center',
};

const button: CSSProperties = {
  minHeight: 44,
  minWidth: 160,
  padding: '0 1.25rem',
  border: 0,
  borderRadius: 8,
  background: BRAND_ACCENT_HEX,
  color: BRAND_BACKGROUND_HEX,
  font: 'inherit',
  fontWeight: 600,
  cursor: 'pointer',
};

/**
 * Root error boundary (SL-1): shown only when the root layout itself fails, so
 * there is no header or tab bar to fall back on. Reload is manual. The crash
 * guard may reload once on its own for a stale-build chunk failure, never while
 * the shell is busy and never twice within ten minutes.
 */
export default function GlobalError({ error }: { error: unknown; retry: () => void }) {
  const crash = useCrashRecovery(error);
  const reloading = crash?.recovery.action === 'auto-reload';
  const repeated = crash?.recovery.action === 'manual' && crash.recovery.reason === 'repeated';

  return (
    <html lang="en">
      <head>
        <title>Something went wrong - HomeHub</title>
      </head>
      <body style={page}>
        <main style={{ maxWidth: 420 }}>
          <svg viewBox={LOGO_VIEWBOX} width={56} height={56} fill="none" aria-hidden focusable="false" style={{ color: BRAND_ACCENT_HEX }}>
            <path d={LOGO_WALLS_PATH} stroke="currentColor" strokeWidth={LOGO_STROKE_WIDTH} strokeLinecap="round" strokeLinejoin="round" />
            <path d={LOGO_ROOF_PATH} stroke="currentColor" strokeWidth={LOGO_STROKE_WIDTH} strokeLinecap="round" strokeLinejoin="round" />
            {LOGO_WINDOWS.map((window) => <rect key={window.x} fill="currentColor" {...window} />)}
            {[...LOGO_EAVE_NODES, LOGO_HUB_NODE].map((node) => <circle key={node.cx} fill="currentColor" {...node} />)}
          </svg>
          <div role="alert">
            <h1 style={{ margin: '1.25rem 0 0', fontSize: '1.5rem', fontWeight: 700 }}>
              {reloading ? 'Getting the latest HomeHub…' : 'HomeHub hit a problem'}
            </h1>
            <p style={{ margin: '0.75rem 0 0', color: MUTED }}>
              {reloading
                ? 'This page needs a newer version of the app. Reloading now.'
                : repeated
                  ? `This keeps happening (last at ${crashTime(crash.at)}). Anything you already saved is safe. Reload to try again, or come back later.`
                  : 'Anything you already saved is safe. Reload to try again.'}
            </p>
          </div>
          {!reloading && (
            <button type="button" style={{ ...button, marginTop: '2rem' }} onClick={() => window.location.reload()}>
              Reload
            </button>
          )}
        </main>
      </body>
    </html>
  );
}
