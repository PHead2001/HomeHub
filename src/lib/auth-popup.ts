/**
 * Google sign-in popup support, kept off the first paint. Auth is created without
 * a popup/redirect resolver (`src/lib/firebase-app.ts`), so Google's `api.js`
 * iframe loader is not fetched before paint. Sign-in passes `signInPopupResolver()`
 * explicitly, and `warmSignInPopup()` initializes that same resolver ahead of the
 * click (after load and idle for signed-out visitors, and when the pointer or
 * focus reaches a Sign-in button), so the click opens the popup without first
 * loading Google's scripts. This restores what `getAuth` did proactively on
 * mobile browsers and Safari.
 *
 * Firebase accepts a resolver instance as well as the class (`_getInstance`
 * returns an instance unchanged), so one warmed instance is shared by the warm-up
 * and `signInWithPopup`. Warming calls the resolver's `_initialize`, the method
 * Firebase itself calls; if a future SDK lacks it, warming is skipped and sign-in
 * still works (the resolver initializes on click, as on desktop before).
 */
import { browserPopupRedirectResolver, type Auth, type PopupRedirectResolver } from 'firebase/auth';
import { auth } from './firebase-app';

type WarmableResolver = PopupRedirectResolver & { _initialize?: (auth: Auth) => Promise<unknown> };

let instance: PopupRedirectResolver | null = null;
let warming: Promise<unknown> | null = null;

/** The one resolver instance used for Google sign-in. */
export function signInPopupResolver(): PopupRedirectResolver {
  if (!instance) {
    try {
      const Resolver = browserPopupRedirectResolver as unknown as new () => PopupRedirectResolver;
      instance = new Resolver();
    } catch {
      instance = browserPopupRedirectResolver;
    }
  }
  return instance;
}

/** Initializes the sign-in resolver once (loads Google's iframe). Never throws. */
export function warmSignInPopup(): void {
  if (warming || typeof window === 'undefined') return;
  const resolver = signInPopupResolver() as WarmableResolver;
  if (typeof resolver._initialize !== 'function') return;
  warming = resolver._initialize(auth).catch(() => {
    warming = null;
  });
}
