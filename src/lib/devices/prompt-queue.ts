// The tablet shell's dialogs as a queue (docs/modules/devices/README.md, "Tablet shell"):
// "Who's here?", the PIN pad and "Feed again?" can be asked by several actions at once (two
// pets fed before the first answer). Each question waits its turn, the first is shown, and
// every one is answered or cancelled: a newer question never replaces an older one, so no
// action is left waiting (with its spinner and the shell's busy mark) for an answer that can
// never come. Pure (no React): the shell reads it with useSyncExternalStore.

export type PromptEntry<P> = { id: number; prompt: P };

export type PromptQueue<P> = {
  /**
   * Queues a question: `make` builds the prompt with its `finish` (the answer; once only, and
   * it takes the prompt off the queue). Resolves with the answer, or `cancelValue` when the
   * queue is cancelled.
   */
  ask<R>(make: (finish: (value: R) => void) => P, cancelValue: R): Promise<R>;
  /** The question shown now (stable until the queue changes), or null. */
  current(): PromptEntry<P> | null;
  /** Questions waiting, the shown one included. */
  size(): number;
  /** Cancels every question (each resolves with its cancel value), e.g. on the idle return. */
  cancelAll(): void;
  subscribe(listener: () => void): () => void;
};

export function createPromptQueue<P>(): PromptQueue<P> {
  type Item = PromptEntry<P> & { cancel: () => void };
  let items: Item[] = [];
  let nextId = 1;
  const listeners = new Set<() => void>();
  const emit = () => listeners.forEach((listener) => listener());

  return {
    ask<R>(make: (finish: (value: R) => void) => P, cancelValue: R): Promise<R> {
      return new Promise<R>((resolve) => {
        const id = nextId;
        nextId += 1;
        let done = false;
        const finish = (value: R) => {
          if (done) return;
          done = true;
          items = items.filter((item) => item.id !== id);
          emit();
          resolve(value);
        };
        items = [...items, { id, prompt: make(finish), cancel: () => finish(cancelValue) }];
        emit();
      });
    },
    current: () => items[0] ?? null,
    size: () => items.length,
    cancelAll() {
      for (const item of [...items]) item.cancel();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
  };
}
