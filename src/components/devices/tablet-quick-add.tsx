'use client';

// The tablet's Add box (design 8.2, JC-28): local matching only. Typing a pet's name
// offers "Feed Maple" (or a dose), typing a chore's title offers "Mark … done"; nothing
// is sent to the AI reader and there is no Speak button on a tablet. Every intent goes
// through the shell's action pipeline ("Who's here?", the PIN when needed, the device
// action). Until the device actions exist (F4) the tablet refuses every write.

import { useMemo, useState } from 'react';
import { CheckSquare, PawPrint, Pill } from 'lucide-react';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { matchLocalIntents, type LocalIntent } from '@/lib/devices/quick-add-local';
import { useUnsavedInput } from '@/hooks/use-shell-busy';
import { useTablet } from './tablet-context';

const ICON = { feed: PawPrint, dose: Pill, complete: CheckSquare } as const;

export function TabletQuickAdd({ onClose }: { onClose: () => void }) {
  const { data, settings, runAction } = useTablet();
  const [text, setText] = useState('');
  useUnsavedInput(text.trim().length > 0);

  const pets = useMemo(() => (data.facts.pets?.pets ?? []).map((pet) => ({ id: pet.id, name: pet.name })), [data.facts.pets]);
  const chores = useMemo(() => {
    const seen = new Map<string, { id: string; title: string }>();
    for (const chore of [...(data.facts.chores?.todayWork ?? []), ...(data.facts.chores?.nextUp ?? [])]) seen.set(chore.id, { id: chore.id, title: chore.task });
    return [...seen.values()];
  }, [data.facts.chores]);
  const intents = matchLocalIntents(text, { pets, chores, sections: settings.sections });

  const choose = (intent: LocalIntent) => {
    setText('');
    onClose();
    void runAction({ capability: intent.capability, label: intent.label });
  };

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
