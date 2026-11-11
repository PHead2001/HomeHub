/**
 * React's own warnings about structural mistakes, as they reach the console in the
 * development build the e2e server runs: siblings with the same key, list children
 * without keys, and hydration mismatches. Deliberately narrow, so third-party
 * noise (camera errors, network retries, extensions) never fails a spec.
 */
export const REACT_STRUCTURE_ERRORS: RegExp[] = [
  /Encountered two children with the same key/i,
  /Each child in a list should have a unique "key" prop/i,
  /Hydration failed/i,
  /There was an error while hydrating/i,
  /did not match\. Server:/i,
  /Text content does not match server-rendered HTML/i,
  /hydrated but some attributes of the server rendered HTML didn't match/i,
];

/** The messages among `messages` that are React structure errors. */
export function reactStructureErrors(messages: readonly string[]): string[] {
  return messages.filter((message) => REACT_STRUCTURE_ERRORS.some((pattern) => pattern.test(message)));
}
