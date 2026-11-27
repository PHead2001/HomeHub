/**
 * SL-19: "Install HomeHub" where the browser offers it. Chromium fires
 * `beforeinstallprompt` when the app is installable; the shell keeps that event
 * (`captureInstallPrompt`, mounted once in the root layout) and Profile shows an
 * **Install HomeHub** card that replays it on a tap. Keeping the event also stops
 * Chrome's own mini-infobar on phones, so the only offer is the one in Profile (the
 * browser's own menu and address-bar install stay). Browsers without the event (Safari,
 * Firefox) never show the card. Nothing is stored.
 */

export type InstallChoice = 'accepted' | 'dismissed' | 'unavailable';

type BeforeInstallPromptEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
};

export type InstallState = 'available' | 'installed' | 'unavailable';

/** Pure: what Profile shows. Running installed (standalone) or just installed wins. */
export function installState(input: { hasPrompt: boolean; standalone: boolean; installed: boolean }): InstallState {
  if (input.standalone || input.installed) return 'installed';
  return input.hasPrompt ? 'available' : 'unavailable';
}

let deferred: BeforeInstallPromptEvent | null = null;
let installed = false;
let captured = false;
const listeners = new Set<() => void>();
const notify = () => { for (const listener of listeners) listener(); };

export function captureInstallPrompt(target: Window = window): void {
  if (captured) return;
  captured = true;
  target.addEventListener('beforeinstallprompt', (event) => {
    event.preventDefault();
    deferred = event as BeforeInstallPromptEvent;
    notify();
  });
  target.addEventListener('appinstalled', () => {
    deferred = null;
    installed = true;
    notify();
  });
}

export function subscribeInstallPrompt(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

let snapshot: { hasPrompt: boolean; installed: boolean } = { hasPrompt: false, installed: false };
/** A stable snapshot for `useSyncExternalStore` (a new object only when something changed). */
export function installPromptSnapshot(): { hasPrompt: boolean; installed: boolean } {
  const hasPrompt = deferred !== null;
  if (snapshot.hasPrompt !== hasPrompt || snapshot.installed !== installed) snapshot = { hasPrompt, installed };
  return snapshot;
}

/** Shows the browser's install dialog. The kept event can be used once. */
export async function promptInstall(): Promise<InstallChoice> {
  const event = deferred;
  if (!event) return 'unavailable';
  deferred = null;
  notify();
  try {
    await event.prompt();
    const { outcome } = await event.userChoice;
    return outcome;
  } catch {
    return 'unavailable';
  }
}

/** Test hook: forget everything. */
export function resetInstallPromptForTests(): void {
  deferred = null;
  installed = false;
  captured = false;
  listeners.clear();
  snapshot = { hasPrompt: false, installed: false };
}
