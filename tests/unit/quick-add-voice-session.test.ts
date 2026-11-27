import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

// The palette attaches to a voice session its opening tap started (QA-16). Anything that
// happened before (a denied microphone, the phrase already finished) must be the state
// the palette is left in: onAttach comes first, then the replay.
type Handler<T> = ((event: T) => void) | null;
class FakeRecognition {
  static last: FakeRecognition | null = null;
  lang = '';
  interimResults = false;
  continuous = false;
  maxAlternatives = 1;
  onresult: Handler<{ results: Array<Array<{ transcript: string }> & { isFinal: boolean }> }> = null;
  onerror: Handler<{ error?: string }> = null;
  onend: (() => void) | null = null;
  start() { FakeRecognition.last = this; }
  stop() { this.onend?.(); }
  abort() {}
}
(globalThis as unknown as { window: unknown }).window = { SpeechRecognition: FakeRecognition };
(globalThis as unknown as { navigator: unknown }).navigator ??= { language: 'en-US' };

describe('voice session replay order', () => {
  it('replays an error and the end after onAttach', async () => {
    const { startVoiceSession, attachVoiceSession } = await import('../../src/components/command/voice-session');
    assert.equal(startVoiceSession(), true);
    FakeRecognition.last!.onerror?.({ error: 'not-allowed' });
    FakeRecognition.last!.onend?.();
    const calls: string[] = [];
    const attachment = attachVoiceSession({
      onAttach: () => calls.push('attach'),
      onText: () => calls.push('text'),
      onError: (message) => calls.push(`error:${message.startsWith('Microphone access is blocked') ? 'blocked' : message}`),
      onEnd: () => calls.push('end'),
    });
    assert.ok(attachment);
    assert.deepEqual(calls, ['attach', 'error:blocked', 'end']);
  });

  it('replays a finished phrase after onAttach', async () => {
    const { startVoiceSession, attachVoiceSession } = await import('../../src/components/command/voice-session');
    assert.equal(startVoiceSession(), true);
    FakeRecognition.last!.onresult?.({ results: [Object.assign([{ transcript: 'fed maple' }], { isFinal: true })] });
    FakeRecognition.last!.onend?.();
    const calls: string[] = [];
    attachVoiceSession({ onAttach: () => calls.push('attach'), onText: (text, final) => calls.push(`${text}:${final}`), onError: () => calls.push('error'), onEnd: () => calls.push('end') });
    assert.deepEqual(calls, ['attach', 'fed maple:true', 'end']);
  });
});
