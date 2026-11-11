/**
 * The promises a `document.startViewTransition()` result carries. Each one
 * rejects when the transition is skipped (another transition starts, the
 * document is hidden) or its update callback times out ("Transition was aborted
 * because of timeout in DOM update"), so a caller that leaves any of them
 * without a handler puts an unhandled rejection in the console (SH-10i).
 */
export type ViewTransitionPromises = {
  ready?: Promise<unknown>;
  finished?: Promise<unknown>;
  updateCallbackDone?: Promise<unknown>;
};

/**
 * Marks every promise of a view transition as handled and returns the
 * transition, so callers keep chaining their own `then`s. Call it on every
 * `startViewTransition` result. A skipped or aborted transition is not an error
 * for HomeHub: the DOM update still ran (or the plain fallback did).
 */
export function settleViewTransition<T extends ViewTransitionPromises>(transition: T): T {
  for (const promise of [transition.ready, transition.finished, transition.updateCallbackDone]) {
    if (promise && typeof promise.catch === 'function') promise.catch(() => undefined);
  }
  return transition;
}
