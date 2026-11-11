import { expect, type Page } from '@playwright/test';
import { reactStructureErrors } from './react-console-patterns';

export { REACT_STRUCTURE_ERRORS, reactStructureErrors } from './react-console-patterns';

/**
 * Collects console errors and uncaught page errors on `page` from now on;
 * `expectClean()` fails the test when any of them is a React key or hydration
 * error, quoting it. Attach right after creating the page, before navigating.
 */
export function watchReactConsole(page: Page) {
  const messages: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error' || message.type() === 'warning') messages.push(message.text());
  });
  page.on('pageerror', (error) => messages.push(`${error.name}: ${error.message}`));
  return {
    messages,
    expectClean(context = 'the page') {
      expect(reactStructureErrors(messages), `React key or hydration errors on ${context}`).toEqual([]);
    },
  };
}
