import { version as runtimeReactVersion } from 'react';

/**
 * Props that make an element `inert` (no focus, no clicks, hidden from assistive tech),
 * spread onto a DOM element or a component that passes DOM props through:
 *
 *   <li {...inertProps(leaving)}>…</li>
 *
 * The two Reacts in this app read the prop differently. React 18 (the installed
 * `react-dom`, used by unit tests and the Pages Router) does not know `inert`: it writes
 * a string value as the attribute and drops `true` with a warning. React 19 (bundled by
 * Next for the App Router, which renders every page here) knows it as a boolean: `true`
 * sets it and an empty string is treated as false with a warning. So the value follows
 * the React that is running, and either one sets the attribute without a warning.
 */
export function inertProps(active: boolean, reactVersion: string = runtimeReactVersion): { inert?: boolean } {
  if (!active) return {};
  const major = Number.parseInt(reactVersion, 10);
  return { inert: (major >= 19 ? true : '') as unknown as boolean };
}
