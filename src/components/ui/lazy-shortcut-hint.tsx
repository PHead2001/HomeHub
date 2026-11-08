'use client';

/**
 * `ShortcutHint` for first-paint files (the header). The tooltip code (Radix
 * Tooltip) loads only once this renders, which in the header is only for signed-in
 * members, so the signed-out landing never downloads it before first paint. Until
 * it has loaded, the child renders as is with its `aria-keyshortcuts` already set
 * from the shortcut map, so nothing shifts and the binding is announced at once.
 *
 *   import { LazyShortcutHint } from '@/components/ui/lazy-shortcut-hint';
 *   <LazyShortcutHint shortcut="palette"><Button …/></LazyShortcutHint>
 *
 * Outside first-paint files use `ShortcutHint` from `@/components/ui/shortcut-hint`.
 */
import { cloneElement, useEffect, useState, type ComponentProps, type ReactElement } from 'react';
import { ariaKeyShortcuts } from '@/lib/dashboard/shortcuts';

type HintModule = typeof import('./shortcut-hint');
type HintProps = ComponentProps<HintModule['ShortcutHint']>;

let loaded: HintModule['ShortcutHint'] | null = null;
let loading: Promise<HintModule['ShortcutHint']> | null = null;
const load = () => {
  loading ??= import('./shortcut-hint').then((mod) => {
    loaded = mod.ShortcutHint;
    return loaded;
  });
  return loading;
};

export function LazyShortcutHint(props: HintProps) {
  const [Hint, setHint] = useState<HintModule['ShortcutHint'] | null>(() => loaded);
  useEffect(() => {
    if (Hint) return;
    let cancelled = false;
    load().then((component) => {
      if (!cancelled) setHint(() => component);
    }).catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [Hint]);

  if (Hint) return <Hint {...props} />;
  return cloneElement(props.children as ReactElement<Record<string, unknown>>, { 'aria-keyshortcuts': ariaKeyShortcuts(props.shortcut) });
}
