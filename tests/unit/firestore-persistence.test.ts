import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  decideLocalPersistence,
  inspectActiveCache,
} from '../../src/lib/firestore-persistence';

/** A Firestore-shaped object whose started client uses `persistence`. */
const withPersistence = (persistence: unknown) => ({
  _firestoreClient: { _offlineComponents: { persistence } },
});

const indexedDbPersistence = (started = true) => ({
  persistenceKey: '[DEFAULT]',
  allowTabSynchronization: true,
  referenceDelegate: {},
  started,
});

const memoryPersistence = (started = true) => ({ referenceDelegate: {}, started });

describe('decideLocalPersistence', () => {
  test('persistent cache requested and running on IndexedDB is durable', () => {
    assert.equal(decideLocalPersistence({ memoryConfigured: false, persistentRequested: true, activeCache: 'indexeddb' }), 'durable');
  });

  test('persistent cache requested but the SDK fell back to memory is not durable', () => {
    // An IndexedDB database may still exist in the profile (another tab, an older
    // session, a newer client's schema); that never counts.
    assert.equal(decideLocalPersistence({ memoryConfigured: false, persistentRequested: true, activeCache: 'memory' }), 'memory');
  });

  test('a client not started yet, or one that cannot be inspected, is unknown', () => {
    assert.equal(decideLocalPersistence({ memoryConfigured: false, persistentRequested: true, activeCache: 'unknown' }), 'unknown');
  });

  test('a reused instance (initializeFirestore threw) is never durable', () => {
    assert.equal(decideLocalPersistence({ memoryConfigured: false, persistentRequested: false, activeCache: 'indexeddb' }), 'unknown');
    assert.equal(decideLocalPersistence({ memoryConfigured: false, persistentRequested: false, activeCache: 'unknown' }), 'unknown');
    assert.equal(decideLocalPersistence({ memoryConfigured: false, persistentRequested: false, activeCache: 'memory' }), 'memory');
  });

  test('a memory-cache build or runtime is memory', () => {
    assert.equal(decideLocalPersistence({ memoryConfigured: true, persistentRequested: false, activeCache: 'unknown' }), 'memory');
  });
});

describe('inspectActiveCache', () => {
  test('a started IndexedDB persistence is indexeddb', () => {
    assert.equal(inspectActiveCache(withPersistence(indexedDbPersistence())), 'indexeddb');
  });

  test('the SDK memory fallback is memory', () => {
    assert.equal(inspectActiveCache(withPersistence(memoryPersistence())), 'memory');
  });

  test('a stopped persistence is unknown', () => {
    assert.equal(inspectActiveCache(withPersistence(indexedDbPersistence(false))), 'unknown');
    assert.equal(inspectActiveCache(withPersistence(memoryPersistence(false))), 'unknown');
  });

  test('a client not started, a terminated instance or an unknown shape is unknown', () => {
    assert.equal(inspectActiveCache({ _firestoreClient: { _offlineComponents: undefined } }), 'unknown');
    assert.equal(inspectActiveCache({ _firestoreClient: undefined }), 'unknown');
    assert.equal(inspectActiveCache(withPersistence({ started: true })), 'unknown');
    assert.equal(inspectActiveCache(null), 'unknown');
    assert.equal(inspectActiveCache(undefined), 'unknown');
  });
});
