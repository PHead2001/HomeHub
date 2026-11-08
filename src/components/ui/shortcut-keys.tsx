/**
 * The keys of a shortcut from the binding map (H28), as `<kbd>`s: "Ctrl / ⌘ + K",
 * "N", "G then C". No tooltip code, so first-paint files (the cheat sheet in the
 * command center) can use it. `ShortcutHint` shows the same inside its tooltip.
 */
import { isShortcutSequence, shortcutById, type ShortcutId } from '@/lib/dashboard/shortcuts';
import { cn } from '@/lib/utils';

const keyLabel = (key: string) => (key === 'Ctrl' ? 'Ctrl / ⌘' : key);

export function ShortcutKeys({ shortcut, className }: { shortcut: ShortcutId; className?: string }) {
  const { keys } = shortcutById(shortcut);
  const sequence = isShortcutSequence({ keys });
  return (
    <span className={cn('inline-flex shrink-0 items-center gap-1', className)} data-shortcut={shortcut}>
      {keys.map((key, index) => (
        <span key={`${key}-${index}`} className="inline-flex items-center gap-1">
          {index > 0 && <span className="text-xs text-muted-foreground">{sequence ? 'then' : '+'}</span>}
          <kbd className="min-w-6 rounded border bg-muted px-1.5 py-0.5 text-center font-sans text-xs text-foreground">{keyLabel(key)}</kbd>
        </span>
      ))}
    </span>
  );
}
