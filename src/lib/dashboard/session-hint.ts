/**
 * Device hint that someone was signed in here (`localStorage["homehub.session"]`),
 * so `/` can choose the dashboard skeleton or the landing page before Firebase
 * Auth has restored the session. Only a "1" flag: no identity, no token. It is a
 * hint, never an authorization: what renders after auth resolves always follows
 * the real session.
 */
export const SESSION_HINT_KEY = 'homehub.session';

/** Inline, dependency-free, never throws: marks `<html data-session="1">` before first paint. */
export const SESSION_GATE_SCRIPT = `try{if(localStorage.getItem(${JSON.stringify(SESSION_HINT_KEY)})==='1')document.documentElement.setAttribute('data-session','1')}catch(e){}`;

/** Keeps the hint in step with the real session once auth has resolved. */
export function writeSessionHint(signedIn: boolean, storage: Pick<Storage, 'setItem' | 'removeItem'> | null): void {
  if (!storage) return;
  try {
    if (signedIn) storage.setItem(SESSION_HINT_KEY, '1');
    else storage.removeItem(SESSION_HINT_KEY);
  } catch {
    // Storage blocked: the page still works, it just cannot pick before auth resolves.
  }
}
