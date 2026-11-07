'use client';

/**
 * Global command center mounted once in the root layout: the command palette
 * (H13/H14), keyboard shortcuts (H28) and the "?" cheat sheet. Active only for
 * approved household members; shortcuts never fire while typing and only for
 * modules the member can use.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { useAuth } from '@/hooks/use-auth';
import { isComposingKey, isTypingTarget, matchShortcut, SHORTCUTS } from '@/lib/dashboard/shortcuts';
import type { HouseholdPermission } from '@/lib/types';
import dynamic from 'next/dynamic';

// The palette searches and writes household data (Firestore); it is its own chunk,
// loaded only once a signed-in member can use it (`enabled`).
const CommandPalette = dynamic(() => import('./command-palette').then((mod) => mod.CommandPalette), { ssr: false });
import { PALETTE_EVENT, SHORTCUT_HELP_EVENT, type PaletteRequest } from './events';

const GO_TIMEOUT_MS = 1200;

// An overlay counts only while it is actually shown. Some menus stay in the DOM while
// closed (the tab bar's quick-add fan is aria-hidden and visibility:hidden, and the
// whole tab bar is display:none on desktop), so a bare role query would block every
// shortcut all the time.
function hasOpenOverlay(): boolean {
  const overlays = document.querySelectorAll<HTMLElement>('[role="dialog"], [role="alertdialog"], [role="menu"]');
  for (const element of overlays) {
    if (element.closest('[aria-hidden="true"]')) continue;
    const visible = typeof element.checkVisibility === 'function'
      ? element.checkVisibility({ checkVisibilityCSS: true } as CheckVisibilityOptions)
      : element.getClientRects().length > 0 && getComputedStyle(element).visibility !== 'hidden';
    if (visible) return true;
  }
  return false;
}

export function CommandCenter() {
  const router = useRouter();
  const { currentUser, currentMember, permissions } = useAuth();
  const enabled = Boolean(currentUser?.householdId && currentMember && currentMember.role !== 'newuser');
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [paletteText, setPaletteText] = useState('');
  const [paletteVoice, setPaletteVoice] = useState(false);
  const [paletteKey, setPaletteKey] = useState(0);
  const [helpOpen, setHelpOpen] = useState(false);
  const pendingGo = useRef(false);
  const goTimer = useRef<number | null>(null);

  const allowed = useCallback((permission?: HouseholdPermission) => !permission || Boolean(permissions[permission]), [permissions]);

  const openPalette = useCallback((request: PaletteRequest = {}) => {
    setPaletteText(request.text ?? '');
    setPaletteVoice(Boolean(request.voice));
    setHelpOpen(false);
    setPaletteKey((key) => key + 1);
    setPaletteOpen(true);
  }, []);

  useEffect(() => {
    if (!enabled) return;
    const onPalette = (event: Event) => openPalette((event as CustomEvent<PaletteRequest>).detail ?? {});
    const onHelp = () => {
      setPaletteOpen(false);
      setHelpOpen(true);
    };
    window.addEventListener(PALETTE_EVENT, onPalette);
    window.addEventListener(SHORTCUT_HELP_EVENT, onHelp);
    return () => {
      window.removeEventListener(PALETTE_EVENT, onPalette);
      window.removeEventListener(SHORTCUT_HELP_EVENT, onHelp);
    };
  }, [enabled, openPalette]);

  useEffect(() => {
    if (!enabled) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || isComposingKey(event) || event.repeat) return;
      const commandKey = (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k';
      // Letters never fire while typing or while another dialog is open; Ctrl/Cmd+K always works.
      if (!commandKey && (isTypingTarget(event.target) || hasOpenOverlay())) return;
      const result = matchShortcut(event, pendingGo.current, allowed);
      pendingGo.current = result.pendingGo;
      if (goTimer.current !== null) window.clearTimeout(goTimer.current);
      if (result.pendingGo) {
        goTimer.current = window.setTimeout(() => {
          pendingGo.current = false;
        }, GO_TIMEOUT_MS);
      }
      const action = result.action;
      if (!action) return;
      event.preventDefault();
      if (action.type === 'palette') openPalette();
      else if (action.type === 'quick-add') openPalette({ text: action.prefix });
      else if (action.type === 'help') setHelpOpen(true);
      else if (action.type === 'go') router.push(action.href);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [enabled, allowed, openPalette, router]);

  if (!enabled) return null;

  const visible = SHORTCUTS.filter((shortcut) => allowed(shortcut.permission));

  return (
    <>
      <CommandPalette key={paletteKey} open={paletteOpen} onOpenChange={setPaletteOpen} initialText={paletteText} startVoice={paletteVoice} />
      <Dialog open={helpOpen} onOpenChange={setHelpOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="font-headline">Keyboard shortcuts</DialogTitle>
            <DialogDescription>Shortcuts never fire while you are typing.</DialogDescription>
          </DialogHeader>
          <ul className="max-h-[60vh] space-y-1 overflow-y-auto" data-testid="shortcut-list">
            {visible.map((shortcut) => (
              <li key={`${shortcut.keys.join('+')}-${shortcut.label}`} className="flex items-center justify-between gap-3 py-1 text-sm">
                <span>{shortcut.label}</span>
                <span className="flex shrink-0 items-center gap-1">
                  {shortcut.keys.map((key, i) => (
                    <span key={key} className="flex items-center gap-1">
                      {i > 0 && <span className="text-xs text-muted-foreground">{shortcut.keys[0] === 'Ctrl' ? '+' : 'then'}</span>}
                      <kbd className="min-w-6 rounded border bg-muted px-1.5 py-0.5 text-center text-xs">{key === 'Ctrl' ? 'Ctrl / ⌘' : key}</kbd>
                    </span>
                  ))}
                </span>
              </li>
            ))}
          </ul>
        </DialogContent>
      </Dialog>
    </>
  );
}
