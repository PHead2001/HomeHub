/**
 * Ambient aurora behind the app shell (H15): two slow blobs in the theme's
 * `--ambient-1`/`--ambient-2` colors plus a faint grain, at the theme's
 * `--ambient-intensity` (5–8%). Loops are ≥ 20 s, pause while the tab is hidden
 * and are static under reduced motion (all in globals.css). Purely decorative.
 */
export function AmbientBackground() {
  return (
    <div aria-hidden className="ambient-aurora">
      <div className="ambient-aurora__blob ambient-aurora__blob--a" />
      <div className="ambient-aurora__blob ambient-aurora__blob--b" />
      <div className="ambient-aurora__grain" />
    </div>
  );
}
