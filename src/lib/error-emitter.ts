
import { EventEmitter } from 'events';
import type { FirestorePermissionError } from './errors';

type ErrorEvents = {
  'permission-error': (error: FirestorePermissionError) => void;
};

class ErrorEventEmitter extends EventEmitter {
  on<U extends keyof ErrorEvents>(event: U, listener: ErrorEvents[U]): this {
    return super.on(event, listener);
  }

  emit<U extends keyof ErrorEvents>(event: U, ...args: Parameters<ErrorEvents[U]>): boolean {
    return super.emit(event, ...args);
  }
}

export const errorEmitter = new ErrorEventEmitter();
