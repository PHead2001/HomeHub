import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import Loading from '../../src/app/maintenance/loading';
import { MaintenanceLoadingState } from '../../src/components/maintenance/maintenance-skeleton';

// MA-25a: the route's loading.tsx and the page's first load render one skeleton, so the
// header and the tab row stay in place on a cold load instead of disappearing and coming back.
describe('maintenance loading skeleton', () => {
  const route = renderToStaticMarkup(createElement(Loading));
  const firstLoad = renderToStaticMarkup(createElement(MaintenanceLoadingState));
  const structure = (html: string) => html.match(/data-testid="maintenance-skeleton[^"]*"/g);

  it('has the header, the tab row and the panel in both', () => {
    for (const html of [route, firstLoad]) {
      assert.match(html, /data-testid="maintenance-skeleton-header"/);
      assert.match(html, /data-testid="maintenance-skeleton-tabs"/);
      assert.match(html, /data-testid="maintenance-skeleton-panel"/);
      assert.match(html, /aria-busy="true"/);
    }
  });

  it('renders the same structure in the same order', () => {
    assert.deepEqual(structure(route), structure(firstLoad));
    const inner = (html: string) => html.slice(html.indexOf('<div class="space-y-6" data-testid="maintenance-skeleton"'));
    assert.equal(inner(route), inner(firstLoad));
  });
});
