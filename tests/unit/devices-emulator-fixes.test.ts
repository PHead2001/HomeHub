import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { createBackStack } from '../../src/lib/shell/back-stack';
import { TABLET_INFO_TOAST_MS, TABLET_TOAST_LIMIT, resumedUndo, tabletToastDuration, tabletToasts } from '../../src/lib/devices/tablet-toasts';
import { noTabletPinMessage } from '../../src/lib/devices/action-policy';
import { deviceCodeInstructions } from '../../src/lib/devices/device-codes';

// The Android-emulator verification's defects (docs/audits/evidence-emulator-goal3.local.md,
// D1-D8): the tablet's Undo target, toasts that never block controls, Done with a dialog open,
// Back closing the topmost dialog, a stale Undo after background, a person with no PIN, the
// setup link while on /setup, and the re-pair code for a tablet still signed in.

const read = (path: string) => readFileSync(path, 'utf8').replace(/\r\n/g, '\n');

describe('D1: the tablet Undo is a 48 px target', () => {
  it('the Undo action carries min-h-12 and min-w-12', () => {
    assert.match(read('src/components/devices/use-device-actions.tsx'), /<ToastAction altText=\{`Undo: \$\{entry\.label\}`\} className="min-h-12 min-w-12[^"]*"/);
  });
});

describe('D2: tablet toasts never block controls', () => {
  it('at most two, newest first, open only', () => {
    const toasts = [{ id: 'c' }, { id: 'b', open: false }, { id: 'a' }, { id: 'z' }];
    assert.equal(TABLET_TOAST_LIMIT, 2);
    assert.deepEqual(tabletToasts(toasts).map((t) => t.id), ['c', 'a']);
  });
  it('an informational toast leaves within 4 s; an Undo keeps the time its window has left', () => {
    assert.equal(TABLET_INFO_TOAST_MS, 4000);
    assert.equal(tabletToastDuration({ duration: 60_000 }), 4000);
    assert.equal(tabletToastDuration({}), 4000);
    assert.equal(tabletToastDuration({ duration: 2000 }), 2000);
    assert.equal(tabletToastDuration({ action: {}, duration: 9000 }), 9000);
  });
  it('the shell uses the tablet toaster at the bottom right; only cards take taps; sections keep a scroll clearance, Home does not', () => {
    const shell = read('src/components/devices/tablet-shell.tsx');
    assert.match(shell, /<Toaster tablet \/>/);
    assert.match(shell, /view\.kind === 'home' \? 'min-h-0 flex-1 overflow-y-auto overscroll-contain' : 'min-h-0 flex-1 overflow-y-auto overscroll-contain pb-40'/);
    const toaster = read('src/components/ui/toaster.tsx');
    assert.match(toaster, /top-auto bottom-0 left-auto right-0/);
    assert.match(read('src/components/ui/toast.tsx'), /"pointer-events-none fixed/);
    assert.match(read('src/components/ui/toast.tsx'), /group pointer-events-auto relative flex/);
  });
});

describe('D3: Done works with a dialog open', () => {
  it('the acting pill sits above the overlay and takes taps through the modal lock', () => {
    assert.match(read('src/components/devices/tablet-top-bar.tsx'), /className="pointer-events-auto relative z-\[60\][^"]*" data-testid="tablet-acting"/);
  });
});

describe('D4: Back closes the topmost dialog', () => {
  const env = () => {
    const history: number[] = [0];
    const calls: string[] = [];
    let pending = 0;
    const stack = createBackStack({
      push: (depth) => { history.push(depth); calls.push(`push ${depth}`); },
      go: (steps) => { history.splice(history.length + steps); pending += 1; calls.push(`go ${steps}`); },
      currentDepth: () => { const top = history[history.length - 1]; return top === 0 ? null : top; },
    });
    const back = () => { history.pop(); stack.pop(); };
    const flush = () => { while (pending > 0) { pending -= 1; stack.pop(); } };
    return { stack, history, calls, back, flush };
  };

  it('Back closes only the topmost of nested dialogs; nothing navigates', () => {
    const { stack, back, history } = env();
    const closed: string[] = [];
    stack.open(() => closed.push('sheet'));
    stack.open(() => closed.push('give dose'));
    back();
    assert.deepEqual(closed, ['give dose']);
    back();
    assert.deepEqual(closed, ['give dose', 'sheet']);
    assert.deepEqual(history, [0], 'back on the page itself');
  });

  it('a dialog closed by its own button takes its entry back once; that popstate never closes another dialog', () => {
    const { stack, flush, history } = env();
    const closed: string[] = [];
    stack.open(() => closed.push('sheet'));
    const inner = stack.open(() => closed.push('pin pad'));
    inner.release();
    flush();
    assert.deepEqual(closed, []);
    assert.deepEqual(history, [0, 1]);
    assert.equal(stack.size(), 1);
  });

  it('closing an outer dialog takes its nested entries with it in one step; a release after Back does nothing', () => {
    const { stack, flush, back, history, calls } = env();
    const outer = stack.open(() => undefined);
    const inner = stack.open(() => undefined);
    outer.release();
    flush();
    assert.deepEqual(history, [0]);
    assert.ok(calls.includes('go -2'));
    inner.release();
    assert.equal(calls.filter((c) => c.startsWith('go')).length, 1, 'no double back');
    const again = stack.open(() => undefined);
    back();
    again.release();
    assert.equal(calls.filter((c) => c.startsWith('go')).length, 1);
  });

  it('when someone navigated meanwhile (the entry is not ours), nothing is taken back', () => {
    const { stack, history, calls } = env();
    const handle = stack.open(() => undefined);
    history.push(0); // a navigation on top
    handle.release();
    assert.equal(calls.filter((c) => c.startsWith('go')).length, 0);
  });

  it('one shared hook is used by the tablet shell dialogs and the Pets dialogs', () => {
    for (const path of [
      'src/components/devices/tablet-pet-sheet.tsx', 'src/components/devices/tablet-views.tsx', 'src/components/devices/tablet-quick-add.tsx',
      'src/components/devices/tablet-settings.tsx', 'src/components/devices/who-is-here.tsx', 'src/components/devices/pin-pad.tsx',
      'src/components/devices/feed-again-prompt.tsx', 'src/components/pets/give-dose-dialog.tsx', 'src/components/pets/course-form-dialog.tsx',
      'src/components/pets/feed-picker-dialog.tsx', 'src/components/pets/correct-feed-time-dialog.tsx', 'src/components/pets/notes-tab.tsx',
      'src/components/pets/legacy-medication-card.tsx', 'src/components/pets/use-feed-action.tsx', 'src/components/medication-log.tsx',
      'src/components/add-pet-dialog.tsx', 'src/components/edit-pet-dialog.tsx', 'src/components/delete-pet-alert.tsx', 'src/components/pet-log-delete-alert.tsx',
    ]) {
      assert.match(read(path), /useBackCloses\(/, path);
    }
    // Other modules' dialogs are unchanged (recorded in the pets README).
    assert.doesNotMatch(read('src/components/shopping-list-client.tsx'), /useBackCloses/);
  });
});

describe('D5: a stale Undo after the background is removed or re-timed', () => {
  it('a passed window removes it; time left re-offers it for that time', () => {
    assert.deepEqual(resumedUndo(0), { kind: 'remove' });
    assert.deepEqual(resumedUndo(-5), { kind: 'remove' });
    assert.deepEqual(resumedUndo(3200), { kind: 'reoffer', remainingMs: 3200 });
  });
  it('the runtime measures every offered Undo again on visibilitychange and pageshow', () => {
    const runtime = read('src/components/devices/use-device-actions.tsx');
    assert.match(runtime, /document\.addEventListener\('visibilitychange', resume\)/);
    assert.match(runtime, /window\.addEventListener\('pageshow', resume\)/);
    assert.match(runtime, /resumedUndo\(undoOffer\(current, Date\.now\(\)\)\.remainingMs\)/);
  });
});

describe('D6: a person with no PIN is told at once and someone else may act', () => {
  it('the copy', () => {
    assert.equal(noTabletPinMessage('Mia Kid'), 'Mia Kid has no tablet PIN. An adult can set one in Household > Members.');
  });
  it('the shell asks the server before the pad, and offers choosing someone else', () => {
    const shell = read('src/components/devices/tablet-shell.tsx');
    assert.match(shell, /devicePinStatusAction\(\{ idToken: await idToken\(\), householdId, actorUid: who\.uid \}\)/);
    assert.match(shell, /const sessionId = required === 'pin' && !unlock \? await pinFor\(who\) : unlock;/);
    assert.match(shell, /choose someone with a tablet PIN/);
  });
});

describe('D7: a setup link opened while on /setup fills the code', () => {
  it('the setup screen reads the fragment on hashchange and popstate too', () => {
    const screen = read('src/components/devices/setup-screen.tsx');
    assert.match(screen, /window\.addEventListener\('hashchange', onHash\)/);
    assert.match(screen, /window\.addEventListener\('popstate', onHash\)/);
  });
});

describe('D8: a re-pair code for a tablet still signed in', () => {
  it('the dialog tells the owner to use the protected exit; the code stays valid through it', () => {
    const copy = deviceCodeInstructions('repair', true, 15);
    assert.match(copy, /still signed in/);
    assert.match(copy, /Use a different code/);
    assert.match(copy, /stays valid through that step/);
    assert.match(deviceCodeInstructions('repair', false, 15), /^On the tablet, open HomeHub and choose Set up a wall tablet\./);
    assert.match(read('src/components/household/devices-tab.tsx'), /stillPaired: device\.status === 'active'/);
  });
});
