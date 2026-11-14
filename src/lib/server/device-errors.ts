import 'server-only';

import type { DeviceRefusal } from '@/lib/devices/action-policy';

/** A device action, PIN verification or op-ledger refusal (section 8.5 codes). */
export class DeviceActionError extends Error {
  constructor(readonly code: DeviceRefusal, readonly retryAfterSec?: number, readonly attemptsLeft?: number) {
    super(code);
    this.name = 'DeviceActionError';
  }
}
