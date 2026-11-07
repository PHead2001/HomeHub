import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { configureFeedback } from '../../src/lib/feedback';
import { PET_VOICES, petVoice, playPetSound, shouldPlayPetSound, voiceDuration } from '../../src/lib/dashboard/pet-sound';

describe('pet sound easter egg', () => {
  it('plays only when Sound is on and Web Audio exists', () => {
    assert.equal(shouldPlayPetSound({ sound: true }, true), true);
    assert.equal(shouldPlayPetSound({ sound: false }, true), false);
    assert.equal(shouldPlayPetSound({ sound: true }, false), false);
    assert.equal(shouldPlayPetSound({ sound: false }, false), false);
  });

  it('barks for dogs, meows for cats and chirps for everyone else', () => {
    assert.equal(petVoice('Dog'), 'bark');
    assert.equal(petVoice('Cat'), 'meow');
    assert.equal(petVoice('Bird'), 'chirp');
    assert.equal(petVoice(undefined), 'chirp');
  });

  it('every voice is short and quiet-shaped (under half a second, positive pitches)', () => {
    for (const voice of Object.keys(PET_VOICES) as Array<keyof typeof PET_VOICES>) {
      assert.ok(voiceDuration(voice) > 0 && voiceDuration(voice) < 0.5, voice);
      for (const note of PET_VOICES[voice]) assert.ok(note.from > 0 && note.to > 0 && note.gain <= 1);
    }
  });

  it('stays silent with Sound off, and never throws without Web Audio', () => {
    configureFeedback({ sound: false, haptics: false });
    assert.equal(playPetSound('Dog'), false);
    configureFeedback({ sound: true, haptics: false });
    // No window/AudioContext in Node: guarded, no throw.
    assert.equal(playPetSound('Cat'), false);
    configureFeedback({ sound: false, haptics: false });
  });
});
