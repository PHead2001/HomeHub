'use client';

/**
 * Keyboard shortcut hints (H28), driven by the one shortcut map in
 * `src/lib/dashboard/shortcuts.ts`, so a hint can never drift from the binding.
 *
 *   import { ShortcutHint } from '@/components/ui/shortcut-hint';
 *
 *   <ShortcutHint shortcut="new-chore">
 *     <Button onClick={openAdd}>Add Chore</Button>
 *   </ShortcutHint>
 *
 * The child (one focusable element) gets a tooltip, shown on hover and on keyboard
 * focus, with the action's label and its keys ("New chore  N"); Radix links the
 * tooltip to the control with `aria-describedby` while it is open. Chords and
 * single keys also set `aria-keyshortcuts` on the child (two-key sequences such as
 * "G then C" cannot be expressed by that attribute; the tooltip still names them).
 * Touch screens never show the tooltip. Pass `label` to word the tooltip for this
 * control; the keys always come from the map.
 *
 * `ShortcutKeys` renders just the keys (for inline hints and the cheat sheet).
 */
import * as React from 'react';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { ariaKeyShortcuts, shortcutById, type ShortcutId } from '@/lib/dashboard/shortcuts';
import { ShortcutKeys } from './shortcut-keys';

export { ShortcutKeys };

export function ShortcutHint({
  shortcut,
  label,
  side = 'bottom',
  children,
}: {
  shortcut: ShortcutId;
  /** Tooltip text before the keys; defaults to the shortcut's own label. */
  label?: string;
  side?: 'top' | 'bottom' | 'left' | 'right';
  /** One focusable element (a Button, Link or button). */
  children: React.ReactElement;
}) {
  const definition = shortcutById(shortcut);
  return (
    <TooltipProvider delayDuration={400}>
      <Tooltip>
        <TooltipTrigger asChild aria-keyshortcuts={ariaKeyShortcuts(shortcut)}>
          {children}
        </TooltipTrigger>
        <TooltipContent side={side} className="flex items-center gap-2" data-testid={`shortcut-hint-${shortcut}`}>
          <span>{label ?? definition.label}</span>
          <ShortcutKeys shortcut={shortcut} />
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
