'use client';

// The tablet's Add box (design 8.2, JC-28): local matching only. Typing a pet's name
// offers "Feed Maple" (or a dose), typing a chore's title offers "Mark … done"; nothing
// is sent to the AI reader and there is no Speak button on a tablet. Every intent goes
// through the shell's action pipeline ("Who's here?", the PIN when needed, the device
// action): a feed is `pets.feed` with the pet's planned portion and latest food type (the
// server picks the meal slot and its portion), a chore is `chores.complete`. While a person
// is remembered, only what they may do is offered (a child's face gets a child's options,
// PE-17e). A dose opens the pet's medication list on the Pets board (F4b-2), where the course
// and the dose time are chosen in Give dose (`pets.dose.give`).

import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { CheckSquare, PawPrint, Pill } from 'lucide-react';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { matchLocalIntents, type LocalIntent } from '@/lib/devices/quick-add-local';
import { petsSection, quickAddTargets } from '@/lib/devices/tablet-sections';
import { personMayUse } from '@/lib/devices/roster';
import { policyOf } from '@/lib/devices/action-policy';
import { useUnsavedInput } from '@/hooks/use-shell-busy';
import { useTablet } from './tablet-context';
import { useBackCloses } from '@/hooks/use-back-closes';

const ICON = { feed: PawPrint, dose: Pill, complete: CheckSquare } as const;

export function TabletQuickAdd({ onClose }: { onClose: () => void }) {
  const { data, settings, runAction, shell, person } = useTablet();
  const [text, setText] = useState('');
  const router = useRouter();
  useUnsavedInput(text.trim().length > 0);

  // Every pet and every open chore of the week (uncapped section facts, never a preview).
  const { pets, chores } = useMemo(() => quickAddTargets(data.sectionFacts ?? {}), [data.sectionFacts]);
  const remembered = person(shell.face?.memberUid);
  const petStates = useMemo(() => new Map((petsSection(data.sectionFacts ?? {}) ?? []).map((pet) => [pet.id, pet])), [data.sectionFacts]);
  const intents = matchLocalIntents(text, { pets, chores, sections: settings.sections, room: settings.room })
    .filter((intent) => !remembered || personMayUse(remembered, policyOf(intent.capability)))
    // A feed needs the pet's feeding history (its portion and food), as the Feed button does.
    .filter((intent) => intent.kind !== 'feed' || Boolean(petStates.get(intent.petId)?.feed));

  const choose = (intent: LocalIntent) => {
    setText('');
    onClose();
    if (intent.kind === 'feed') {
      // The same request as the Feed button: the planned portion (the server uses the meal slot's) and the latest food type.
      const pet = petStates.get(intent.petId);
      const feed = pet?.feed;
      if (!pet || !feed) return;
      void runAction({
        capability: 'pets.feed',
        label: `Fed ${pet.name}`,
        subject: pet.name,
        intent: { petId: intent.petId, portion: { amount: feed.amount, unit: feed.unit }, portionFromSlot: Boolean(feed.portionFromSlot), food: feed.foodType },
      });
      return;
    }
    if (intent.kind === 'dose') {
      // Which course and which dose are chosen in Give dose, from the pet's medication list.
      router.push(`/pets/${encodeURIComponent(intent.petId)}?tab=medication`);
      return;
    }
    void runAction({
      capability: intent.capability,
      label: intent.label,
      intent: { choreId: intent.choreId },
    });
  };

  // Android Back closes this first (emulator evidence D4).
  useBackCloses(true, onClose);

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="max-w-xl" data-testid="tablet-quick-add">
        <DialogHeader>
          <DialogTitle className="font-headline text-2xl">Add</DialogTitle>
          <DialogDescription>Type a pet&apos;s name or a chore. This tablet matches what it already shows.</DialogDescription>
        </DialogHeader>
        <Input
          autoFocus
          value={text}
          onChange={(event) => setText(event.target.value)}
          placeholder="Feed Maple, take out the trash…"
          aria-label="What happened?"
          className="min-h-12 text-lg"
          data-testid="tablet-quick-add-input"
        />
        <ul className="space-y-2" aria-live="polite">
          {intents.map((intent) => {
            const Icon = ICON[intent.kind];
            return (
              <li key={`${intent.kind}-${'petId' in intent ? intent.petId : intent.choreId}`}>
                <button
                  type="button"
                  onClick={() => choose(intent)}
                  className="flex min-h-14 w-full items-center gap-3 rounded-xl border border-border bg-card px-4 text-left text-lg"
                  data-testid="tablet-quick-add-intent"
                >
                  <Icon aria-hidden className="h-5 w-5 text-primary" />
                  {intent.label}
                </button>
              </li>
            );
          })}
          {text.trim() && intents.length === 0 && <li className="text-muted-foreground">Nothing on this tablet matches that.</li>}
        </ul>
      </DialogContent>
    </Dialog>
  );
}
