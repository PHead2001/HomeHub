import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { afterEach, describe, it } from 'node:test';
import { journalEntry, journalStep, restorableUndos, undoToastGroup, DEVICE_ACTION_TOAST_GROUP } from '../../src/lib/devices/undo-journal';
import { addToast } from '../../src/lib/shell/toast-queue';
import { createPromptQueue } from '../../src/lib/devices/prompt-queue';
import { isShellBusy, resetShellBusyForTests, whileBusy } from '../../src/lib/shell/busy';
import { petFeedToastGroup } from '../../src/lib/pets/feed-decision';

// PR #185 review (Codex P2s): each pet keeps its own Undo toast on a tablet, live and after a
// reload, and concurrent "Feed again?" questions are queued so every one is answered or
// cancelled and no save stays busy (docs/modules/devices/README.md, "Device actions: pets").

const read = (path: string) => readFileSync(path, 'utf8');
const session = { householdId: 'h1', deviceId: 'd1', generation: 1 };
const entryOf = (opId: string, capability: 'pets.feed' | 'chores.complete', label: string, toastGroup?: string, at = 1_000) =>
  journalStep(journalEntry({ opId, ...session, capability, actorUid: 'u1', label, ...(toastGroup ? { toastGroup } : {}), at }), { type: 'answered', at, undoable: true });
type T = { id: string; open: boolean; holdsAction: boolean; group: string };
const toastOf = (id: string, group: string): T => ({ id, open: true, holdsAction: true, group });

describe('tablet Undo toasts keep a group per pet (Codex P2 1)', () => {
  it('a feed stores its pet group in the journal; chores and older entries use the shared group', () => {
    const maple = entryOf('a', 'pets.feed', 'Fed Maple', petFeedToastGroup('maple'));
    assert.equal(maple.toastGroup, 'pet-feed:maple');
    assert.equal(undoToastGroup(maple), 'pet-feed:maple');
    assert.equal(undoToastGroup(entryOf('b', 'chores.complete', 'Done: Dishes')), DEVICE_ACTION_TOAST_GROUP);
    // A journal written before this change has no toastGroup.
    assert.equal(undoToastGroup({ ...maple, toastGroup: undefined }), DEVICE_ACTION_TOAST_GROUP);
  });

  it('after a reload the restored toasts keep their pet groups', () => {
    const entries = [
      entryOf('a', 'pets.feed', 'Fed Maple', petFeedToastGroup('maple'), 1_000),
      entryOf('b', 'pets.feed', 'Fed Rex', petFeedToastGroup('rex'), 2_000),
      entryOf('c', 'chores.complete', 'Done: Dishes', undefined, 3_000),
    ];
    const restored = restorableUndos(entries, 5_000, session);
    const groups = Object.fromEntries(restored.map(({ entry }) => [entry.opId, undoToastGroup(entry)]));
    assert.deepEqual(groups, { a: 'pet-feed:maple', b: 'pet-feed:rex', c: DEVICE_ACTION_TOAST_GROUP });
  });

  it('feeding another pet or completing a chore does not remove a feed\'s Undo; the same pet replaces its own', () => {
    let toasts: T[] = [];
    toasts = addToast(toasts, toastOf('maple', undoToastGroup(entryOf('a', 'pets.feed', 'Fed Maple', petFeedToastGroup('maple')))));
    toasts = addToast(toasts, toastOf('rex', undoToastGroup(entryOf('b', 'pets.feed', 'Fed Rex', petFeedToastGroup('rex')))));
    assert.deepEqual(toasts.map((t) => t.id), ['rex', 'maple']);
    toasts = addToast(toasts, toastOf('chore', undoToastGroup(entryOf('c', 'chores.complete', 'Done: Dishes'))));
    assert.deepEqual(toasts.map((t) => t.id), ['chore', 'rex', 'maple'], 'a chore Undo leaves both feeds');
    toasts = addToast(toasts, toastOf('chore2', undoToastGroup(entryOf('d', 'chores.complete', 'Done: Trash'))));
    assert.deepEqual(toasts.map((t) => t.id), ['chore2', 'rex', 'maple'], 'a newer chore replaces the older chore only');
    toasts = addToast(toasts, toastOf('maple2', undoToastGroup(entryOf('e', 'pets.feed', 'Fed Maple', petFeedToastGroup('maple')))));
    assert.deepEqual(toasts.map((t) => t.id), ['maple2', 'chore2', 'rex']);
  });

  it('the runtime and the feed hook carry the group (live and restored toasts)', () => {
    const runtime = read('src/components/devices/use-device-actions.tsx');
    assert.ok(runtime.includes('group: undoToastGroup(entry)'));
    assert.ok(!runtime.includes("group: 'device-action'"));
    assert.match(runtime, /label, \.\.\.\(toastGroup \? \{ toastGroup \} : \{\}\) \}/);
    assert.ok(read('src/components/devices/tablet-shell.tsx').includes('toastGroup: request.toastGroup'));
    assert.ok(read('src/components/pets/use-feed-action.tsx').includes('toastGroup: petFeedToastGroup(petId)'));
  });
});

describe('concurrent tablet prompts are queued (Codex P2 2)', () => {
  afterEach(() => resetShellBusyForTests());

  it('two "Feed again?" questions at once: one shown at a time, each answered, the saves end and the shell is idle', async () => {
    const queue = createPromptQueue<{ title: string; resolve: (yes: boolean) => void }>();
    const ask = (title: string) => queue.ask<boolean>((finish) => ({ title, resolve: finish }), false);
    // Two pets fed before the first answer: each save is busy until its question is answered.
    const first = whileBusy('save', ask('Feed Maple again?'));
    const second = whileBusy('save', ask('Feed Rex again?'));
    await Promise.resolve();
    assert.equal(queue.size(), 2);
    assert.equal(queue.current()!.prompt.title, 'Feed Maple again?', 'the older question stays on screen');
    assert.ok(isShellBusy());
    queue.current()!.prompt.resolve(true);
    assert.equal(await first, true);
    assert.equal(queue.current()!.prompt.title, 'Feed Rex again?', 'the next question is shown');
    queue.current()!.prompt.resolve(false);
    assert.equal(await second, false);
    assert.equal(queue.current(), null);
    assert.equal(isShellBusy(), false, 'no spinner or busy mark is left');
  });

  it('cancelling (idle return) resolves every waiting question with its cancel value', async () => {
    const queue = createPromptQueue<{ kind: string; resolve: (value: unknown) => void }>();
    const who = whileBusy('save', queue.ask<string | null>((finish) => ({ kind: 'who', resolve: finish as (v: unknown) => void }), null));
    const again = whileBusy('save', queue.ask<boolean>((finish) => ({ kind: 'feed-again', resolve: finish as (v: unknown) => void }), false));
    queue.cancelAll();
    assert.deepEqual(await Promise.all([who, again]), [null, false]);
    assert.equal(queue.size(), 0);
    assert.equal(isShellBusy(), false);
  });

  it('an answer counts once; a late answer to a finished question changes nothing', async () => {
    const queue = createPromptQueue<{ resolve: (yes: boolean) => void }>();
    const one = queue.ask<boolean>((finish) => ({ resolve: finish }), false);
    const two = queue.ask<boolean>((finish) => ({ resolve: finish }), false);
    const shown = queue.current()!;
    shown.prompt.resolve(true);
    shown.prompt.resolve(false);
    assert.equal(await one, true);
    assert.equal(queue.size(), 1);
    queue.current()!.prompt.resolve(true);
    assert.equal(await two, true);
  });

  it('the shell asks through the queue and keys each dialog by its question', () => {
    const shell = read('src/components/devices/tablet-shell.tsx');
    assert.ok(!shell.includes('setPrompt('), 'no single prompt slot that a newer question overwrites');
    assert.ok(shell.includes('prompts.cancelAll()'));
    for (const kind of ['who', 'pin', 'feed-again']) assert.ok(shell.includes(`kind: '${kind}'`), kind);
    assert.equal((shell.match(/key=\{shown\?\.id\}/g) ?? []).length, 3);
  });
});
