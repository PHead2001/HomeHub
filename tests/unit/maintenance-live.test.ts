import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { initialLiveState, liveReducer, liveView, MAINTENANCE_COLLECTIONS, type LiveEvent } from '../../src/lib/maintenance/live-data';
import { recentLogSummary } from '../../src/lib/maintenance/recent';
import { deepLinkPlan } from '../../src/lib/maintenance/deep-link';
import { completionFormValues, emptyLogForm, logFormFromRecord } from '../../src/components/maintenance/page-model';
import { householdToday } from '../../src/lib/household-day';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

const answerAll = (key: string, docs: Record<string, unknown[]> = {}) => MAINTENANCE_COLLECTIONS.reduce(
  (state, collection) => liveReducer(state, { type: 'answer', key, session: 1, collection, docs: docs[collection] ?? [], fromCache: false }),
  initialLiveState(),
);

describe('maintenance live data (MA-2)', () => {
  it('is ready only once every collection answered for the key', () => {
    let state = initialLiveState();
    for (const collection of MAINTENANCE_COLLECTIONS.slice(0, 3)) {
      state = liveReducer(state, { type: 'answer', key: 'h1|u1', session: 1, collection, docs: [], fromCache: false });
      assert.equal(liveView(state, 'h1|u1').ready, false);
    }
    state = liveReducer(state, { type: 'answer', key: 'h1|u1', session: 1, collection: 'maintenance-attachments', docs: [], fromCache: false });
    assert.equal(liveView(state, 'h1|u1').ready, true);
  });

  it('never shows one household\'s records under another key', () => {
    const state = answerAll('h1|u1', { 'home-assets': [{ id: 'furnace', name: 'Furnace' }] });
    assert.equal(liveView(state, 'h1|u1').assets.length, 1);
    const other = liveView(state, 'h2|u1');
    assert.deepEqual([other.assets, other.ready], [[], false]);
    // A late answer for the new key starts over: nothing of h1 survives.
    const next = liveReducer(state, { type: 'answer', key: 'h2|u1', session: 1, collection: 'vehicles', docs: [{ id: 'car' }], fromCache: false });
    assert.deepEqual(liveView(next, 'h2|u1').assets, []);
    assert.equal(liveView(next, 'h2|u1').vehicles.length, 1);
    // A late answer from the old key's listener cannot bring h1 back for h2.
    assert.deepEqual(liveView(next, 'h2|u1').assets, []);
  });

  it('keeps loaded records through a transient failure and retries quietly', () => {
    const loaded = answerAll('h1|u1', { maintenance: [{ id: 'log' }] });
    const failing = liveReducer(loaded, { type: 'failure', key: 'h1|u1', session: 1, collection: 'maintenance', failure: 'retrying' });
    const view = liveView(failing, 'h1|u1');
    assert.deepEqual([view.logs.length, view.ready, view.failure], [1, true, null]);
  });

  it('is the error state when a collection fails before the first load, until it answers', () => {
    let state = liveReducer(initialLiveState(), { type: 'failure', key: 'h1|u1', session: 1, collection: 'vehicles', failure: 'retrying' });
    assert.equal(liveView(state, 'h1|u1').failure, 'retrying');
    state = MAINTENANCE_COLLECTIONS.reduce((current, collection) => liveReducer(current, { type: 'answer', key: 'h1|u1', session: 1, collection, docs: [], fromCache: false }), state);
    assert.deepEqual([liveView(state, 'h1|u1').failure, liveView(state, 'h1|u1').ready], [null, true]);
  });

  it('clears every protected record when access is refused, and stays cleared', () => {
    const loaded = answerAll('h1|u1', { 'home-assets': [{ id: 'furnace' }], maintenance: [{ id: 'log' }] });
    const refused = liveReducer(loaded, { type: 'failure', key: 'h1|u1', session: 1, collection: 'home-assets', failure: 'unauthorized' });
    const view = liveView(refused, 'h1|u1');
    assert.deepEqual([view.assets, view.logs, view.vehicles, view.attachments, view.ready, view.failure], [[], [], [], [], false, 'unauthorized']);
    // A cached answer from another listener arriving afterwards shows nothing again.
    const late: LiveEvent = { type: 'answer', key: 'h1|u1', session: 1, collection: 'maintenance', docs: [{ id: 'log' }], fromCache: false };
    assert.deepEqual(liveView(liveReducer(refused, late), 'h1|u1').logs, []);
  });

  it('recovers when the listeners are recreated under the same key (access granted again)', () => {
    const refused = liveReducer(answerAll('h1|u1'), { type: 'failure', key: 'h1|u1', session: 1, collection: 'vehicles', failure: 'unauthorized' });
    assert.equal(liveView(refused, 'h1|u1').failure, 'unauthorized');
    // Session 2 (resubscribed): its first answer starts over.
    let state = liveReducer(refused, { type: 'answer', key: 'h1|u1', session: 2, collection: 'home-assets', docs: [{ id: 'furnace' }], fromCache: false });
    assert.deepEqual([liveView(state, 'h1|u1').failure, liveView(state, 'h1|u1').ready], [null, false]);
    for (const collection of MAINTENANCE_COLLECTIONS.slice(1)) {
      state = liveReducer(state, { type: 'answer', key: 'h1|u1', session: 2, collection, docs: [], fromCache: false });
    }
    assert.deepEqual([liveView(state, 'h1|u1').ready, liveView(state, 'h1|u1').assets.length], [true, 1]);
  });

  it('is confirmed only once every collection answered from the server', () => {
    let state = MAINTENANCE_COLLECTIONS.reduce(
      (current, collection) => liveReducer(current, { type: 'answer', key: 'h1|u1', session: 1, collection, docs: [], fromCache: true }),
      initialLiveState(),
    );
    assert.deepEqual([liveView(state, 'h1|u1').ready, liveView(state, 'h1|u1').confirmed], [true, false]);
    for (const collection of MAINTENANCE_COLLECTIONS) {
      state = liveReducer(state, { type: 'answer', key: 'h1|u1', session: 1, collection, docs: [], fromCache: false });
    }
    assert.equal(liveView(state, 'h1|u1').confirmed, true);
  });
});

describe('maintenance 30-day counts in household days (MA-11f)', () => {
  const zone = 'America/Chicago';
  const log = (date: string, cost?: number) => ({ date, cost });

  it('counts today and the 29 days before it, by the household calendar', () => {
    const logs = [log('2026-08-01', 10), log('2026-07-03', 20), log('2026-07-02', 40), log('2026-08-05', 1)];
    // 07-02 is 30 days before 08-01: outside. A log dated after today still counts (as before).
    assert.deepEqual(recentLogSummary(logs, [], [], '2026-08-01', zone), { recentLogs: 3, recentCost: 31, needingAttention: 0 });
  });

  it('reads a legacy instant in the household zone, not the device zone', () => {
    // 04:30Z on Jul 3 is still Jul 2 in Chicago: outside the window for Aug 1.
    assert.equal(recentLogSummary([log('2026-07-03T04:30:00.000Z', 5)], [], [], '2026-08-01', zone).recentLogs, 0);
    // In Tokyo it is already Jul 3: inside.
    assert.equal(recentLogSummary([log('2026-07-03T04:30:00.000Z', 5)], [], [], '2026-08-01', 'Asia/Tokyo').recentLogs, 1);
  });

  it('moves with the household day and ignores logs without a readable date', () => {
    const logs = [log('2026-07-03', 20), log('not a date', 99)];
    assert.equal(recentLogSummary(logs, [], [], '2026-08-01', zone).recentLogs, 1);
    assert.equal(recentLogSummary(logs, [], [], '2026-08-02', zone).recentLogs, 0);
  });

  it('counts flagged assets and vehicles', () => {
    const summary = recentLogSummary([], [{ status: 'needs_attention' }, { status: 'active' }], [{ status: 'needs_attention' }], '2026-08-01', zone);
    assert.equal(summary.needingAttention, 2);
  });
});

describe('maintenance deep links', () => {
  const records = { assets: [{ id: 'hvac' }], vehicles: [{ id: 'suv' }], logs: [{ id: 'oil' }] };

  it('opens a record and its schedule, or says it is gone', () => {
    assert.deepEqual(deepLinkPlan('?asset=hvac&schedule=hvac%3Afilter', records), {
      tab: 'assets', selectAssetId: 'hvac', selectVehicleId: null, highlightedLogId: null,
      highlightedScheduleKey: 'hvac:filter', notice: null, scrollTo: { kind: 'schedule', id: 'hvac:filter' },
    });
    assert.equal(deepLinkPlan('?targetType=vehicle&targetId=suv', records).selectVehicleId, 'suv');
    assert.equal(deepLinkPlan('?vehicle=gone', records).notice, 'The requested vehicle is no longer available.');
    assert.deepEqual(deepLinkPlan('?log=oil', records).scrollTo, { kind: 'log', id: 'oil' });
    assert.equal(deepLinkPlan('?log=gone', records).tab, 'logs');
  });

  it('follows ?tab= and ignores unknown tabs', () => {
    assert.equal(deepLinkPlan('?tab=reminders', records).tab, 'reminders');
    assert.equal(deepLinkPlan('?tab=nope', records).tab, null);
    assert.equal(deepLinkPlan('', records).tab, null);
  });
});

describe('date defaults use the household day (Codex review of PR #210)', () => {
  // 00:30 UTC on Mar 2: London's (and UTC's) Mar 2, still Mar 1 in a Chicago household.
  const instant = new Date('2026-03-02T00:30:00Z');
  const today = householdToday('America/Chicago', instant);
  const asset = { id: 'hvac', name: 'HVAC', category: 'HVAC', status: 'active' } as never;
  const schedule = { id: 'filter', mode: 'scheduled', scheduleName: 'Filter', frequencyType: 'months', intervalValue: 3, nextDueDate: '2026-03-01' } as never;

  it('fills the completion dialog and Log service with the household day, not the device day', () => {
    assert.equal(today, '2026-03-01');
    const values = completionFormValues({ targetType: 'home_asset', asset, scheduleIndex: 0, schedule }, today);
    assert.equal(values.completedDate, '2026-03-01');
    assert.equal(values.nextDueDate, '2026-06-01');
    assert.equal(emptyLogForm({ targetType: 'home_asset', assetId: 'hvac', title: 'Filter' }, today).date, '2026-03-01');
    assert.equal(logFormFromRecord({ id: 'l', title: 'x' } as never, today).date, '2026-03-01');
  });

  it('has no device-date default left in the maintenance page code', () => {
    const dir = resolve(process.cwd(), 'src/components/maintenance');
    const files = [...readdirSync(dir).map((file) => resolve(dir, file)), resolve(process.cwd(), 'src/components/maintenance-log-client.tsx')];
    for (const file of files) {
      const source = readFileSync(file, 'utf8');
      assert.doesNotMatch(source, /todayInputValue|format\(new Date\(\)/, file);
    }
  });
});
