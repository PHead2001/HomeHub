import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';
import { tickCompletesChore } from '../../src/lib/chores/steps';
import { planCompletion, planUndo } from '../../src/lib/chores/completion';

describe('auto-complete on the last step (CH-33)', () => {
  it('completes only when the tick closes the last open step of an open chore', () => {
    const chore = { subTasks: ['Rinse', 'Dry'], completedSubTasks: ['Rinse'], isCompleted: false };
    assert.equal(tickCompletesChore(chore, 'Dry'), true);
    assert.equal(tickCompletesChore(chore, 'Rinse'), false, 'unticking never completes');
    assert.equal(tickCompletesChore({ ...chore, completedSubTasks: [] }, 'Dry'), false);
    assert.equal(tickCompletesChore({ ...chore, isCompleted: true }, 'Dry'), false);
    assert.equal(tickCompletesChore({ subTasks: [], completedSubTasks: [], isCompleted: false }, 'Dry'), false);
  });

  it("the completion's Undo puts the steps back as they were before the tick", () => {
    const stored = { task: 'Dishes', isCompleted: false, subTasks: ['Rinse', 'Dry'], completedSubTasks: ['Rinse'], originalDueDate: '2026-11-27', dueDate: '2026-11-27T06:00:00.000Z' };
    const plan = planCompletion(stored, { completer: { uid: 'u', name: 'Sam' }, now: new Date('2026-11-27T18:00:00Z'), timeZone: 'America/Chicago', completeSubTasks: true, completionId: 'c1' });
    assert.equal(plan.kind, 'complete');
    if (plan.kind !== 'complete') return;
    assert.deepEqual(plan.completion.completedSubTasks, ['Rinse', 'Dry']);
    assert.deepEqual(plan.previousCompletedSubTasks, ['Rinse']);
    const undo = planUndo({ ...stored, ...plan.fields }, 'c1', { from: plan.completion.completedSubTasks, to: plan.previousCompletedSubTasks! });
    assert.equal(undo.kind, 'undo');
    if (undo.kind === 'undo') assert.deepEqual(undo.completedSubTasks, ['Rinse']);
  });

  it('goes through the server completion from the step toggle', () => {
    const page = readFileSync(resolve(process.cwd(), 'src/components/chore-chart-client.tsx'), 'utf8');
    // CH-30: a kid's last step on a photo chore only records the step.
    assert.match(page, /if \(tickCompletesChore\(chore, subTask\) && !needsPhoto\(chore\) && !isDueAfterHouseholdDay\(chore, householdDay, household\?\.timeZone\)\) \{/);
    assert.match(page, /void completeChores\(\[chore\], check\?\.getBoundingClientRect\(\) \?\? null\);/);
  });
});
