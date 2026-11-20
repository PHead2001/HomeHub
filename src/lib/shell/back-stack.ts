// Back closes the topmost dialog (emulator evidence D4; docs/modules/devices/README.md and
// docs/modules/pets/README.md). Pure over a small history environment, unit tested; the
// browser binding is `useBackCloses` (src/hooks/use-back-closes.ts).
//
// - A dialog that opens pushes one history entry (same URL, state `{ hhBack: depth }`).
// - Back (popstate) closes only the topmost open dialog; nothing else navigates (the entry
//   under it is the page itself).
// - A dialog closed any other way (a button, Escape, an outside tap) takes its entry back off
//   with one `history.go(-n)` (its own entry and any nested ones above it), whose popstate is
//   ignored, so there is never a double back. When the current entry is not ours (someone
//   navigated meanwhile), nothing is taken back.

export type BackEnvironment = {
  /** Pushes an entry for this depth (same URL). */
  push: (depth: number) => void;
  /** history.go(-steps). */
  go: (steps: number) => void;
  /** Our depth on the current history entry, or null when it isn't one of ours. */
  currentDepth: () => number | null;
};

export type BackHandle = { release: () => void };

export function createBackStack(env: BackEnvironment) {
  const open: { depth: number; close: () => boolean | void }[] = [];
  let ignore = 0;

  return {
    /**
     * A dialog opened: its entry is pushed; `close` runs if Back is pressed while it is the
     * topmost. `close` returns false when the dialog refuses to close (a save in flight): its
     * entry is pushed again and it stays registered, so the next Back still closes it (Codex 5).
     */
    open(close: () => boolean | void): BackHandle {
      const depth = (open[open.length - 1]?.depth ?? 0) + 1;
      const entry = { depth, close };
      open.push(entry);
      env.push(depth);
      return {
        release: () => {
          const index = open.indexOf(entry);
          if (index < 0) return; // closed by Back already
          // This dialog and any nested ones above it leave together.
          const top = open[open.length - 1].depth;
          open.splice(index);
          if (env.currentDepth() === top) {
            ignore += 1;
            env.go(-(top - depth + 1));
          }
        },
      };
    },
    /** A popstate: ours to ignore (a release), or Back closing the topmost dialog. */
    pop(): void {
      if (ignore > 0) {
        ignore -= 1;
        return;
      }
      const top = open.pop();
      if (!top) return;
      if (top.close() === false) {
        open.push(top);
        env.push(top.depth);
      }
    },
    /** For tests: how many dialogs hold an entry. */
    size: () => open.length,
  };
}

let browserStack: ReturnType<typeof createBackStack> | null = null;

/** The one stack for this page (created on first use, in the browser only). */
export function browserBackStack(): ReturnType<typeof createBackStack> | null {
  if (typeof window === 'undefined') return null;
  if (!browserStack) {
    browserStack = createBackStack({
      push: (depth) => window.history.pushState({ ...(window.history.state ?? {}), hhBack: depth }, ''),
      go: (steps) => window.history.go(steps),
      currentDepth: () => {
        const depth = (window.history.state as { hhBack?: unknown } | null)?.hhBack;
        return typeof depth === 'number' ? depth : null;
      },
    });
    const stack = browserStack;
    window.addEventListener('popstate', () => stack.pop());
  }
  return browserStack;
}
