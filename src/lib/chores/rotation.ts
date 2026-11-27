/**
 * Rotations on the client (CH-28): the template fields to write and the small
 * list edits of the rotation editor. The turn rule itself is the server's
 * (`functions/src/shared/rotation.ts`), shared with the calendar.
 */
import { MAX_ROTATION, rotationOf } from '../../../functions/src/shared/rotation';

export { MAX_ROTATION, rotationOf };

/**
 * The rotation fields to store for a template whose rotation becomes `next`:
 * null when it has no rotation (fewer than two people: the fields are removed).
 * An unchanged rotation keeps its `rotationStart`, so editing only the schedule
 * keeps the turn order counting from the same day; a new or reordered rotation
 * starts on `today` (the household day) with the first person in the list.
 */
export function rotationFieldsFor(
  previous: { rotation?: unknown; rotationStart?: unknown } | null | undefined,
  next: readonly string[],
  today: string,
): { rotation: string[]; rotationStart: string } | null {
  const rotation = rotationOf({ rotation: [...next] });
  if (rotation.length === 0) return null;
  const before = rotationOf(previous);
  const same = before.length === rotation.length && before.every((uid, index) => uid === rotation[index]);
  const start = previous?.rotationStart;
  return { rotation, rotationStart: same && typeof start === 'string' && start ? start : today };
}

/** Adds `uid` at the end of the rotation, or removes it. */
export function toggleRotationMember(list: readonly string[], uid: string): string[] {
  if (list.includes(uid)) return list.filter(item => item !== uid);
  return list.length >= MAX_ROTATION ? [...list] : [...list, uid];
}

/** Moves the person at `index` one place up (-1) or down (+1). */
export function moveRotationMember(list: readonly string[], index: number, delta: -1 | 1): string[] {
  const target = index + delta;
  if (index < 0 || index >= list.length || target < 0 || target >= list.length) return [...list];
  const next = [...list];
  [next[index], next[target]] = [next[target], next[index]];
  return next;
}

/** "Sam, Alex and Kim take turns" for a rotation, by the names given. */
export function rotationText(rotation: readonly string[], nameOf: (uid: string) => string): string {
  const names = rotation.map(nameOf);
  if (names.length === 0) return '';
  const list = names.length === 1 ? names[0] : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
  return `${list} take turns`;
}
