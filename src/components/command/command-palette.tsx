'use client';

/**
 * Command palette (H13) with natural-language quick-add and voice add (H14).
 * Ctrl/Cmd+K, "/", the header search button or the tab bar's quick-add open it.
 * Typing searches pages, chores, lists, items, pets and maintenance records; a
 * sentence the deterministic parser understands becomes a quick-add suggestion.
 * Choosing it shows a preview, and nothing is written until "Confirm". Works fully
 * by keyboard (combobox + listbox pattern). There is no cmdk dependency in this
 * project, so the list is a small hand-built listbox.
 */
import { useCallback, useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import {
  ArrowLeft,
  Bell,
  Bot,
  CalendarDays,
  CheckSquare,
  Home,
  Loader2,
  Mic,
  PawPrint,
  Plus,
  ScanBarcode,
  Search,
  ShoppingCart,
  User,
  Users,
  Wrench,
  type LucideIcon,
} from 'lucide-react';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { useAuth } from '@/hooks/use-auth';
import { useToast } from '@/hooks/use-toast';
import { playFeedback } from '@/lib/feedback';
import { cn } from '@/lib/utils';
import type { HouseholdPermission } from '@/lib/types';
import { assignableMembers, describeRepeat, parseQuickAdd, quickAddRetryMessage, resolveChoreAssignee, type QuickAddIntent, type QuickAddMember } from '@/lib/dashboard/quick-add';
import { choreCapabilities } from '@/lib/chores/list';
import { DEFAULT_PORTION, formatPortion } from '@/lib/pets/care';
import type { PortionUnit } from '@/lib/pets/types';
import { MAINTENANCE_LOGS_HREF } from '@/lib/dashboard/links';
import { friendlyError } from '@/lib/friendly-error';
import { notifyDataChanged } from '@/lib/data-changed';
import { GO_TARGETS } from '@/lib/dashboard/shortcuts';
import { matchScore, useCommandIndex } from './use-command-index';
import { addShoppingItems, createOneTimeChore, logFeeding } from './quick-add-actions';
import { useVoiceInput } from './use-voice-input';

type Page = { href: string; label: string; icon: LucideIcon; permission?: HouseholdPermission; keywords?: string };

const PAGES: Page[] = [
  { href: '/', label: 'Home', icon: Home, keywords: 'dashboard' },
  { href: '/chores', label: 'Chores', icon: CheckSquare, permission: 'chores.view', keywords: 'tasks chart' },
  { href: '/calendar', label: 'Calendar', icon: CalendarDays, permission: 'chores.view', keywords: 'schedule week month' },
  { href: '/shopping', label: 'Shopping', icon: ShoppingCart, permission: 'shopping.view', keywords: 'lists pantry groceries' },
  { href: '/pets', label: 'Pets', icon: PawPrint, permission: 'pets.view', keywords: 'feeding' },
  { href: '/maintenance', label: 'Maintenance', icon: Wrench, permission: 'maintenance.view', keywords: 'assets vehicles' },
  { href: '/automation', label: 'Automation', icon: Bot, permission: 'automation.view', keywords: 'home assistant' },
  { href: '/notifications', label: 'Notifications', icon: Bell, permission: 'notifications.view' },
  { href: '/household', label: 'Household', icon: Users, permission: 'household.view', keywords: 'members invite roles' },
  { href: '/library', label: 'Barcode Library', icon: ScanBarcode, keywords: 'products' },
  { href: '/profile', label: 'Profile', icon: User, keywords: 'settings appearance theme' },
];

const goHint = (href: string) => {
  const letter = Object.entries(GO_TARGETS).find(([, target]) => target.href === href)?.[0];
  return letter ? `G ${letter.toUpperCase()}` : undefined;
};

type Option = {
  id: string;
  group: string;
  label: string;
  detail?: string;
  hint?: string;
  icon: LucideIcon;
  run: () => void;
};

const INTENT_PERMISSION: Record<QuickAddIntent['kind'], HouseholdPermission> = {
  shopping: 'shopping.edit',
  feeding: 'pets.addLogs',
  chore: 'chores.create',
  // The same permission Maintenance requires to log (the preview opens its form).
  maintenance: 'maintenance.createLogs',
};

/** The amount to log: the one in the sentence, else the pet's usual portion, else the Pets default. */
function feedingPortion(intent: Extract<QuickAddIntent, { kind: 'feeding' }>): { amount: number; unit: PortionUnit } {
  if (intent.amount !== null) return { amount: intent.amount, unit: intent.unit ?? intent.pet.portion?.unit ?? DEFAULT_PORTION.unit };
  return intent.pet.portion ?? DEFAULT_PORTION;
}

function describeIntent(intent: QuickAddIntent, self: QuickAddMember | null): { title: string; detail: string } {
  switch (intent.kind) {
    case 'shopping':
      return {
        title: `Add ${intent.items.map((item) => (item.quantity > 1 ? `${item.quantity} × ${item.name}` : item.name)).join(', ')}`,
        detail: intent.list ? `to ${intent.list.name}` : 'No shopping list yet',
      };
    case 'feeding': {
      const portion = feedingPortion(intent);
      return { title: `Log a meal for ${intent.pet.name}`, detail: `${formatPortion(portion.amount, portion.unit)}, now` };
    }
    case 'chore': {
      const who = intent.assignee ?? self;
      const when = intent.repeat ? describeRepeat(intent.repeat) : `due ${new Date(`${intent.dueDate}T12:00:00`).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })}`;
      return { title: `Chore: ${intent.task}`, detail: `${when}${who ? ` · for ${who.name}` : ''}` };
    }
    case 'maintenance':
      return { title: `Log maintenance: ${intent.title}`, detail: intent.mileage ? `at ${intent.mileage.toLocaleString()} miles` : 'Opens Maintenance' };
  }
}

export function CommandPalette({
  open,
  onOpenChange,
  initialText,
  startVoice,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initialText: string;
  startVoice: boolean;
}) {
  const router = useRouter();
  const { currentUser, permissions } = useAuth();
  const { toast, toastError } = useToast();
  const index = useCommandIndex(open);
  const voice = useVoiceInput();
  // The command center remounts the palette (new `key`) each time it opens, so the
  // initial text comes straight from props.
  const [text, setText] = useState(initialText);
  const [activeChoice, setActive] = useState(0);
  const [pending, setPending] = useState<QuickAddIntent | null>(null);
  const [saving, setSaving] = useState(false);
  const [retryMessage, setRetryMessage] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listId = useId();
  const optionId = (i: number) => `${listId}-option-${i}`;

  const self = useMemo<QuickAddMember | null>(() => {
    if (!currentUser) return null;
    return index.members.find((member) => member.uid === currentUser.uid || member.email === currentUser.email)
      ?? { uid: currentUser.uid, email: currentUser.email, name: currentUser.displayName || currentUser.email };
  }, [currentUser, index.members]);

  const canAssign = choreCapabilities(permissions).canAssign;
  const assignable = useMemo(() => {
    if (!currentUser) return [];
    const list = assignableMembers(index.members, currentUser, canAssign);
    return list.length > 0 || !self ? list : [self];
  }, [index.members, currentUser, canAssign, self]);

  const close = useCallback(() => onOpenChange(false), [onOpenChange]);
  const navigate = useCallback((href: string) => {
    close();
    router.push(href);
  }, [close, router]);

  const intent = useMemo(() => {
    if (!currentUser) return null;
    const parsed = parseQuickAdd(text, {
      now: new Date(),
      viewer: { uid: currentUser.uid, email: currentUser.email },
      members: index.members,
      pets: index.pets,
      lists: index.lists,
    });
    if (!parsed || !permissions[INTENT_PERMISSION[parsed.kind]]) return null;
    if (parsed.kind === 'shopping' && !parsed.list) return null;
    return parsed;
  }, [text, currentUser, index.members, index.pets, index.lists, permissions]);

  const options = useMemo<Option[]>(() => {
    const search = text.trim();
    const pages = PAGES.filter((page) => !page.permission || permissions[page.permission]);
    const pageOptions: Option[] = pages
      .map((page) => ({ page, score: search ? Math.max(matchScore(page.label, search), matchScore(page.keywords ?? '', search) ? 1 : 0) : 1 }))
      .filter((entry) => entry.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, search ? 4 : PAGES.length)
      .map(({ page }) => ({
        id: `page-${page.href}`,
        group: 'Go to',
        label: page.label,
        hint: goHint(page.href),
        icon: page.icon,
        run: () => navigate(page.href),
      }));

    const groupIcons: Record<string, LucideIcon> = { Chores: CheckSquare, Shopping: ShoppingCart, Pets: PawPrint, Maintenance: Wrench };
    const records: Option[] = search
      ? index.entries
          .map((entry) => ({ entry, score: matchScore(entry.label, search) }))
          .filter((item) => item.score > 0)
          .sort((a, b) => b.score - a.score)
          .slice(0, 8)
          .map(({ entry }) => ({
            id: entry.id,
            group: entry.group,
            label: entry.label,
            detail: entry.detail,
            icon: groupIcons[entry.group],
            run: () => navigate(entry.href),
          }))
      : [];

    const quick: Option[] = [];
    // Bare words ("milk and eggs") become a shopping suggestion only when search finds nothing.
    if (intent && !(intent.kind === 'shopping' && !intent.explicit && records.length + pageOptions.length > 0)) {
      const description = describeIntent(intent, self);
      quick.push({
        id: 'quick-add',
        group: 'Quick add',
        label: description.title,
        detail: description.detail,
        hint: 'Enter',
        icon: Plus,
        run: () => setPending(intent),
      });
    }
    return [...quick, ...records, ...pageOptions];
  }, [text, permissions, index.entries, intent, self, navigate]);

  const active = Math.min(activeChoice, Math.max(0, options.length - 1));

  // Keep the active option visible as arrow keys move past the list's edge
  // (aria-activedescendant already points at it; this moves the scroll box only).
  const activeOptionId = options[active] ? optionId(active) : null;
  useEffect(() => {
    if (!activeOptionId) return;
    document.getElementById(activeOptionId)?.scrollIntoView({ block: 'nearest' });
  }, [activeOptionId]);

  const listen = useCallback(() => {
    voice.start((spoken, final) => {
      setText(spoken);
      setActive(0);
      if (final) inputRef.current?.focus();
    });
  }, [voice]);

  useEffect(() => {
    if (open && startVoice && voice.supported) listen();
    // Only when the palette is opened by the tab bar's long-press.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, startVoice, voice.supported]);

  useEffect(() => {
    if (!open && voice.listening) voice.stop();
  }, [open, voice]);

  const confirm = async (choreAssignee?: QuickAddMember | null) => {
    const householdId = currentUser?.householdId;
    if (!pending || !householdId || !currentUser) return;
    const lateError = (error: unknown) => toastError(error, 'Could not sync');
    setSaving(true);
    try {
      if (pending.kind === 'shopping' && pending.list) {
        const outcome = await addShoppingItems(householdId, pending.list, pending.items, lateError);
        if (outcome.saved.length > 0) {
          notifyDataChanged({ module: 'shopping', householdId, listId: pending.list.id });
          toast({ title: outcome.queued ? 'Saved offline' : 'Added to the list', description: `${outcome.saved.map((item) => item.name).join(', ')} on ${pending.list.name}.` });
          playFeedback('add');
        }
        if (outcome.failed.length > 0) {
          // Keep only what failed, so Confirm retries those and never re-adds the saved ones.
          setPending({ ...pending, items: outcome.failed });
          setRetryMessage(`${quickAddRetryMessage(outcome.failed)} ${friendlyError(outcome.firstError)}`);
          return;
        }
        close();
        return;
      } else if (pending.kind === 'feeding') {
        const portion = feedingPortion(pending);
        const status = await logFeeding(householdId, pending.pet.id, portion.amount, portion.unit, currentUser, lateError);
        notifyDataChanged({ module: 'pets', householdId, petId: pending.pet.id });
        toast({ title: status === 'queued' ? 'Saved offline' : 'Feeding logged', description: status === 'queued' ? `${pending.pet.name}'s feeding will sync when you're back online.` : `${pending.pet.name} has been fed.` });
      } else if (pending.kind === 'chore') {
        // Without chores.assign the chore can only be yours (as in the Add Chore dialog).
        const { assignee } = resolveChoreAssignee(choreAssignee ?? pending.assignee, assignable, self);
        if (!assignee) throw new Error('missing-assignee');
        const { choreId, status } = await createOneTimeChore({ householdId, viewer: currentUser, task: pending.task, dueDate: pending.dueDate, assignee, onLateError: lateError });
        notifyDataChanged({ module: 'chores', householdId, choreId });
        toast({ title: status === 'queued' ? 'Saved offline' : 'Chore added', description: status === 'queued' ? `${pending.task} will sync when you're back online.` : `${pending.task} for ${assignee.name}.` });
      }
      playFeedback('add');
      close();
    } catch (error) {
      toastError(error, 'Could not save');
    } finally {
      setSaving(false);
    }
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setActive(options.length ? (active + 1) % options.length : 0);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActive(options.length ? (active - 1 + options.length) % options.length : 0);
    } else if (event.key === 'Enter') {
      event.preventDefault();
      options[active]?.run();
    }
  };

  let lastGroup = '';
  const listItems: ReactNode[] = [];
  options.forEach((option, i) => {
    if (option.group !== lastGroup) {
      lastGroup = option.group;
      listItems.push(
        <li key={`group-${option.group}`} role="presentation" className="px-3 pb-1 pt-3 text-xs font-medium text-muted-foreground">
          {option.group}
        </li>,
      );
    }
    const Icon = option.icon;
    listItems.push(
      <li
        key={option.id}
        id={optionId(i)}
        role="option"
        aria-selected={i === active}
        data-testid={option.id === 'quick-add' ? 'palette-quick-add' : undefined}
        onPointerMove={() => setActive(i)}
        onClick={() => option.run()}
        className={cn(
          'mx-1 flex cursor-pointer items-center gap-3 rounded-md px-2 py-2 text-sm',
          i === active ? 'bg-accent text-accent-foreground' : 'text-foreground',
        )}
      >
        <Icon aria-hidden className={cn('h-4 w-4 shrink-0', option.id === 'quick-add' ? 'text-primary' : 'text-muted-foreground')} />
        <span className="min-w-0 flex-1">
          <span className="block truncate">{option.label}</span>
          {option.detail && <span className="block truncate text-xs text-muted-foreground">{option.detail}</span>}
        </span>
        {option.hint && <kbd className="hidden shrink-0 rounded border bg-muted px-1.5 text-[11px] text-muted-foreground sm:inline">{option.hint}</kbd>}
      </li>,
    );
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent hideClose className="top-[12%] max-w-lg translate-y-0 gap-0 overflow-hidden p-0 sm:top-[15%]" data-testid="command-palette">
        <DialogTitle className="sr-only">Search or quick add</DialogTitle>
        <DialogDescription className="sr-only">
          Search HomeHub, or type a sentence like &quot;milk and eggs to groceries&quot;, &quot;fed Maple&quot; or &quot;vacuum Friday for Sam&quot;.
        </DialogDescription>
        {pending ? (
          <QuickAddPreview
            intent={pending}
            self={self}
            members={assignable}
            saving={saving}
            message={retryMessage}
            onBack={() => {
              setPending(null);
              setRetryMessage(null);
              window.setTimeout(() => inputRef.current?.focus(), 0);
            }}
            onConfirm={confirm}
            onNavigate={navigate}
          />
        ) : (
          <>
            <div className="flex items-center gap-2 border-b px-3">
              <Search aria-hidden className="h-4 w-4 shrink-0 text-muted-foreground" />
              <input
                ref={inputRef}
                autoFocus
                value={text}
                onChange={(event) => {
                  setText(event.target.value);
                  setActive(0);
                }}
                onKeyDown={onKeyDown}
                role="combobox"
                aria-expanded="true"
                aria-controls={listId}
                aria-activedescendant={activeOptionId ?? undefined}
                aria-autocomplete="list"
                aria-label="Search or quick add"
                placeholder="Search, or type “milk and eggs to groceries”"
                className="h-12 min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
              />
              {voice.supported && (
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className={cn('h-9 w-9 shrink-0', voice.listening && 'text-primary')}
                  aria-label={voice.listening ? 'Stop listening' : 'Speak to quick add'}
                  aria-pressed={voice.listening}
                  onClick={() => (voice.listening ? voice.stop() : listen())}
                >
                  {voice.listening ? <VoiceWave /> : <Mic aria-hidden />}
                </Button>
              )}
            </div>
            {voice.error && <p role="alert" className="border-b px-4 py-2 text-xs text-destructive">{voice.error}</p>}
            <ul id={listId} role="listbox" aria-label="Results" className="max-h-[min(60vh,24rem)] overflow-y-auto pb-2">
              {listItems.length > 0 ? listItems : (
                <li role="presentation" className="px-4 py-6 text-center text-sm text-muted-foreground">
                  {index.loading ? 'Loading…' : 'No matches. Try “add milk” or “chore vacuum tomorrow”.'}
                </li>
              )}
            </ul>
            <p className="hidden border-t px-4 py-2 text-[11px] text-muted-foreground sm:block">
              ↑ ↓ to move · Enter to choose · Esc to close · ? for shortcuts
            </p>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

function VoiceWave() {
  return (
    <span aria-hidden className="flex h-4 items-center gap-0.5">
      {[0, 1, 2, 3].map((bar) => (
        <span
          key={bar}
          className="w-0.5 animate-pulse rounded-full bg-current"
          style={{ height: `${[8, 14, 10, 6][bar]}px`, animationDelay: `${bar * 120}ms` }}
        />
      ))}
    </span>
  );
}

function QuickAddPreview({
  intent,
  self,
  members,
  saving,
  message,
  onBack,
  onConfirm,
  onNavigate,
}: {
  intent: QuickAddIntent;
  self: QuickAddMember | null;
  members: QuickAddMember[];
  saving: boolean;
  /** Inline note after a partial save: which entries are left to retry. */
  message?: string | null;
  onBack: () => void;
  onConfirm: (assignee?: QuickAddMember | null) => void;
  onNavigate: (href: string) => void;
}) {
  const resolved = intent.kind === 'chore' ? resolveChoreAssignee(intent.assignee, members, self) : { assignee: null, restricted: false };
  const [assigneeEmail, setAssigneeEmail] = useState(resolved.assignee?.email ?? '');
  const description = describeIntent(intent.kind === 'chore' ? { ...intent, assignee: resolved.assignee } : intent, self);
  const assignee = members.find((member) => member.email === assigneeEmail) ?? (self?.email === assigneeEmail ? self : null);
  const confirmRef = useRef<HTMLButtonElement>(null);
  useEffect(() => confirmRef.current?.focus(), []);

  // Recurring chores and maintenance logs need their module's full form.
  const handOff = intent.kind === 'maintenance'
    ? { href: MAINTENANCE_LOGS_HREF, label: 'Open Maintenance', note: 'Maintenance logs need a target and details, so this opens Maintenance where you can log it.' }
    : intent.kind === 'chore' && intent.repeat
      ? { href: '/chores', label: 'Open Chores', note: 'Repeating chores are set up from a chore template in Chores. Quick add can create one-time chores.' }
      : null;

  return (
    <div className="p-4" data-testid="quick-add-preview">
      <p className="text-xs font-medium text-muted-foreground">Check before saving</p>
      <div className="mt-2 rounded-lg border bg-muted/40 p-3">
        <p className="font-medium">{description.title}</p>
        <p className="text-sm text-muted-foreground">{description.detail}</p>
      </div>
      {resolved.restricted && (
        <p className="mt-3 text-sm text-muted-foreground" data-testid="quick-add-assignee-restricted">
          You can only assign chores to yourself, so this one will be yours.
        </p>
      )}
      {intent.kind === 'chore' && !intent.repeat && members.length > 1 && (
        <label className="mt-3 block text-sm">
          <span className="mb-1 block text-muted-foreground">Assign to</span>
          <select
            value={assigneeEmail}
            onChange={(event) => setAssigneeEmail(event.target.value)}
            className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
          >
            {members.map((member) => (
              <option key={member.email} value={member.email}>{member.name}</option>
            ))}
          </select>
        </label>
      )}
      {handOff && <p className="mt-3 text-sm text-muted-foreground">{handOff.note}</p>}
      {message && <p role="alert" className="mt-3 text-sm text-destructive" data-testid="quick-add-retry">{message}</p>}
      <div className="mt-4 flex justify-between gap-2">
        <Button type="button" variant="ghost" onClick={onBack} disabled={saving}>
          <ArrowLeft aria-hidden className="mr-2 h-4 w-4" />
          Back
        </Button>
        {handOff ? (
          <Button ref={confirmRef} type="button" onClick={() => onNavigate(handOff.href)}>{handOff.label}</Button>
        ) : (
          <Button ref={confirmRef} type="button" onClick={() => onConfirm(assignee)} disabled={saving} data-testid="quick-add-confirm">
            {saving && <Loader2 aria-hidden className="mr-2 h-4 w-4 animate-spin" />}
            Confirm
          </Button>
        )}
      </div>
    </div>
  );
}
