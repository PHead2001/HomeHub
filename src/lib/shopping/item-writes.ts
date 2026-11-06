import { increment } from 'firebase/firestore';

/**
 * The update that merges `add` more of an item into an existing shopping-list
 * item. Always an atomic `increment()`, never a total computed from a local read:
 * two members (or a device with a stale list) adding the same item both count,
 * and the increment queues offline like any other write.
 */
export function quantityIncrement(add: number) {
  return { quantity: increment(add) };
}
