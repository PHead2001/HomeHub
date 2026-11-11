import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  ORPHAN_DELETE_PAGE_SIZE,
  afterPage,
  purgeOrphanList,
} from '../../scripts/ops/shopping-orphans.mjs';

/**
 * In-memory Firestore stand-in. Paths are strings; a collection is `<doc>/<id>`.
 * `deletePage` mirrors the script's transaction: it reads the list flag first
 * and deletes nothing when the list exists. `onPage` runs after each page
 * commits, so a test can re-create the list (and add its new items) between
 * pages the way a member would.
 */
function fakeStore(paths: string[], onPage?: (state: { calls: number; docs: Set<string>; setList: (exists: boolean) => void }) => void) {
  const docs = new Set(paths);
  let listExists = false;
  let calls = 0;
  const pageDeletes: string[][] = [];
  const childCollections = (ref: string) => {
    const depth = ref.split('/').length;
    const ids = new Set<string>();
    for (const path of docs) {
      if (path.startsWith(`${ref}/`) && path.split('/').length >= depth + 2) ids.add(path.split('/').slice(0, depth + 1).join('/'));
    }
    return [...ids].sort();
  };
  const docsIn = (collection: string, withDescendants: boolean) => {
    const depth = collection.split('/').length;
    const ids = new Set<string>();
    for (const path of docs) {
      if (!path.startsWith(`${collection}/`)) continue;
      const parts = path.split('/');
      if (parts.length === depth + 1) ids.add(path);
      else if (withDescendants && parts.length > depth + 1) ids.add(parts.slice(0, depth + 1).join('/'));
    }
    return [...ids].sort();
  };
  const store = {
    subcollections: async (ref: unknown) => childCollections(ref as string),
    documentRefs: async (collection: unknown) => docsIn(collection as string, true),
    deletePage: async (_listRef: unknown, collection: unknown, pageSize: number) => {
      calls += 1;
      let result: { listExists: boolean; deleted: number };
      if (listExists) {
        pageDeletes.push([]);
        result = { listExists: true, deleted: 0 };
      } else {
        const page = docsIn(collection as string, false).slice(0, pageSize);
        for (const path of page) docs.delete(path);
        pageDeletes.push(page);
        result = { listExists: false, deleted: page.length };
      }
      onPage?.({ calls, docs, setList: exists => { listExists = exists; } });
      return result;
    },
  };
  return { store, docs, pageDeletes, setList: (exists: boolean) => { listExists = exists; } };
}

const LIST = 'h/shopping-lists/weekly';
const items = (count: number, prefix = 'old') => Array.from({ length: count }, (_, index) => `${LIST}/items/${prefix}-${String(index).padStart(3, '0')}`);

describe('afterPage', () => {
  test('stops when the list exists, continues after a full page, finishes after a short one', () => {
    assert.equal(afterPage({ listExists: true, deleted: 0 }, 2), 'stop');
    assert.equal(afterPage({ listExists: false, deleted: 2 }, 2), 'next');
    assert.equal(afterPage({ listExists: false, deleted: 1 }, 2), 'done');
    assert.equal(afterPage({ listExists: false, deleted: 0 }, 2), 'done');
  });

  test('the default page fits one transaction', () => {
    assert.ok(ORPHAN_DELETE_PAGE_SIZE > 0 && ORPHAN_DELETE_PAGE_SIZE <= 500);
  });
});

describe('purgeOrphanList', () => {
  test('deletes items, categories and deeper documents in bounded pages', async () => {
    const nested = `${LIST}/items/old-000/notes/n1`;
    const { store, docs, pageDeletes } = fakeStore([...items(5), `${LIST}/config/categories`, nested, 'h/shopping-lists/other/items/keep']);
    const result = await purgeOrphanList(store, LIST, { pageSize: 2 });
    assert.deepEqual(result, { outcome: 'purged', deleted: 7 });
    assert.deepEqual([...docs], ['h/shopping-lists/other/items/keep']);
    assert.ok(pageDeletes.every(page => page.length <= 2));
    // The nested document goes before the item that holds it.
    const nestedPage = pageDeletes.findIndex(page => page.includes(nested));
    const firstItemPage = pageDeletes.findIndex(page => page.some(path => path.includes('/items/old-') && !path.includes('/notes/')));
    assert.ok(nestedPage >= 0 && nestedPage < firstItemPage);
  });

  test('a list re-created before the first page loses nothing', async () => {
    const { store, docs, setList } = fakeStore([...items(3), `${LIST}/config/categories`]);
    setList(true);
    const result = await purgeOrphanList(store, LIST, { pageSize: 2 });
    assert.deepEqual(result, { outcome: 'recreated', deleted: 0 });
    assert.equal(docs.size, 4);
  });

  test('a list re-created between pages keeps its new items and categories', async () => {
    const fresh = [`${LIST}/items/new-milk`, `${LIST}/config/categories`];
    const { store, docs, pageDeletes } = fakeStore([...items(5)], ({ calls, docs: live, setList }) => {
      if (calls !== 1) return;
      // A member re-creates the list, then adds to it.
      setList(true);
      for (const path of fresh) live.add(path);
    });
    const result = await purgeOrphanList(store, LIST, { pageSize: 2 });
    assert.deepEqual(result, { outcome: 'recreated', deleted: 2 });
    for (const path of fresh) assert.ok(docs.has(path), `${path} survives`);
    // Only the first page deleted anything; every page after the re-creation stopped.
    assert.deepEqual(pageDeletes.slice(1).flat(), []);
    assert.equal(pageDeletes.length, 2);
  });

  test('no subcollections means nothing to do', async () => {
    const { store, pageDeletes } = fakeStore([]);
    assert.deepEqual(await purgeOrphanList(store, LIST), { outcome: 'purged', deleted: 0 });
    assert.equal(pageDeletes.length, 0);
  });

  test('rejects a page size that cannot make progress', async () => {
    const { store } = fakeStore(items(1));
    await assert.rejects(purgeOrphanList(store, LIST, { pageSize: 0 }), RangeError);
  });
});
