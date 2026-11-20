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
// - A traversal is asynchronous in a browser: a dialog that opens before the popstate of one
//   we started (Tablet settings handing over to its admin picker) is pushed only once that
//   popstate has arrived, so its entry is never the one the traversal leaves (Codex #190).

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
  type Entry = { depth: number; close: () => boolean | void; pushed: boolean };
  const open: Entry[] = [];
  // Traversals we started (`go`) whose popstate has not arrived yet. A browser traverses
  // asynchronously: an entry pushed before that popstate would be the one the traversal
  // leaves, so a dialog that opens meanwhile waits for it (`waiting`) and is pushed after.
  let ignore = 0;
  const waiting: Entry[] = [];
  const pushNow = (entry: Entry) => {
    entry.pushed = true;
    env.push(entry.depth);
  };
  const flush = () => {
    while (ignore === 0 && waiting.length > 0) {
      const entry = waiting.shift()!;
      if (open.includes(entry)) pushNow(entry);
    }
  };

  return {
    /**
     * A dialog opened: its entry is pushed (after any traversal still on its way); `close` runs
     * if Back is pressed while it is the topmost. `close` returns false when the dialog refuses
     * to close (a save in flight): its entry is pushed again and it stays registered, so the
     * next Back still closes it (Codex 5).
     */
    open(close: () => boolean | void): BackHandle {
      const depth = (open[open.length - 1]?.depth ?? 0) + 1;
      const entry: Entry = { depth, close, pushed: false };
      open.push(entry);
      if (ignore > 0) waiting.push(entry);
      else pushNow(entry);
      return {
        release: () => {
          const index = open.indexOf(entry);
          if (index < 0) return; // closed by Back already
          // This dialog and any nested ones above it leave together.
          const leaving = open.splice(index);
          for (const gone of leaving) {
            const at = waiting.indexOf(gone);
            if (at >= 0) waiting.splice(at, 1);
          }
          // Only entries already in the history are taken back.
          const pushed = leaving.filter((gone) => gone.pushed);
          if (pushed.length > 0 && env.currentDepth() === pushed[pushed.length - 1].depth) {
            ignore += 1;
            env.go(-pushed.length);
          }
        },
      };
    },
    /** A popstate: ours to ignore (a release), or Back closing the topmost dialog. */
    pop(): void {
      if (ignore > 0) {
        ignore -= 1;
        flush();
        return;
      }
      const top = open[open.length - 1];
      if (!top || !top.pushed) return;
      open.pop();
      if (top.close() === false) {
        open.push(top);
        pushNow(top);
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
