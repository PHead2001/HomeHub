'use client';

/**
 * Command palette (H13) with natural-language quick-add and voice add (H14).
 * Ctrl/Cmd+K, "/" or the header search button open it for typing; the dashboard
 * tile "+" buttons, the N/A/F shortcuts and the tab bar's quick-add open it in a
 * mode (Feeding, Item, Chore: `palette-modes.tsx`, QA-15).
 * Typing searches pages, chores, lists, items, pets and maintenance records; a
 * sentence the deterministic parser understands becomes a quick-add suggestion.
 * A sentence it cannot read can be read by AI on request ("Read it with AI", the
 * `parseCommand` action), which returns the same kind of suggestion. Choosing one
 * shows a preview card, and nothing is written until "Confirm": then it adds the
 * shopping items, logs the feeding, creates the one-time or repeating chore (with
 * its assignee and room) or logs the maintenance (with the odometer reading, for
 * the chosen vehicle). Works fully by keyboard (combobox + listbox pattern). There
 * is no cmdk dependency in this project, so the list is a small hand-built listbox.
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
  Sparkles,
  User,
  Users,
  Wrench,
  type LucideIcon,
} from 'lucide-react';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { ToastAction } from '@/components/ui/toast';
import { Stagger } from '@/components/motion/stagger';
import { parseCommand } from '@/ai/flows/parse-command-flow';
import { getAiActionContext, unwrapAiActionResult } from '@/ai/client';
import { useAuth } from '@/hooks/use-auth';
import { useToast } from '@/hooks/use-toast';
import { playFeedback } from '@/lib/feedback';
import { cn } from '@/lib/utils';
import type { HouseholdPermission } from '@/lib/types';
import { assignableMembers, describeRepeat, parseQuickAdd, createSettlementGuard, planUnconfirmedSettlement, quickAddRetryMessage, resolveChoreAssignee, unconfirmedShoppingMessage, type MaintenanceTarget, type QuickAddAsset, type QuickAddContext, type QuickAddIntent, type QuickAddMember, type QuickAddRoom, type QuickAddVehicle } from '@/lib/dashboard/quick-add';
import { buildAiParseRequest, createRevisionGuard, intentFromAiParse, shouldOfferAiParse } from '@/lib/dashboard/quick-add-ai';
import { mileageNote } from '@/lib/dashboard/quick-add-writes';
import { defaultMaintenanceTarget, describeIntent, failedSectionsFor, feedingPortion, maintenanceTargetName as targetName, quickAddConfirmBlocker, type IndexSection } from '@/lib/dashboard/quick-add-preview';
import { choreCapabilities } from '@/lib/chores/list';
import { friendlyError } from '@/lib/friendly-error';
import { notifyDataChanged } from '@/lib/data-changed';
import { FEED_UNDO_MS, feedAgainPrompt } from '@/lib/pets/feed-decision';
import { undoFeed } from '@/lib/pets/feed-operation';
import { GO_TARGETS, isComposingKey } from '@/lib/dashboard/shortcuts';
import { matchScore, useCommandIndex } from './use-command-index';
import { addShoppingItems, createOneTimeChore, createRepeatingChore, logFeeding, logMaintenance } from './quick-add-actions';
import { useVoiceInput } from './use-voice-input';
import { ChoreMode, FeedingMode, ItemMode } from './palette-modes';
import { bareVerbOffer, feedingModeState, itemModeState, modeBlocker, MODE_PERMISSION, type PaletteMode } from '@/lib/dashboard/palette-mode';

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
  // The same permission Maintenance requires to add a log.
  maintenance: 'maintenance.createLogs',
};

/** What the member picked in the preview card. */
export type PreviewChoices = {
  assignee: QuickAddMember | null;
  room: QuickAddRoom | null;
  target: MaintenanceTarget | null;
};

const NO_CHOICES: PreviewChoices = { assignee: null, room: null, target: null };

export function CommandPalette({
  open,
  onOpenChange,
  initialMode,
  startVoice,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Open in Feeding, Item or Chore mode (QA-15); null opens the typing palette. */
  initialMode: PaletteMode | null;
  startVoice: boolean;
}) {
  const router = useRouter();
  const { currentUser, permissions, household } = useAuth();
  const { toast, toastError } = useToast();
  const index = useCommandIndex(open);
  const voice = useVoiceInput();
  // The command center remounts the palette (new `key`) each time it opens, so the
  // initial mode comes straight from props.
  const [mode, setMode] = useState<PaletteMode | null>(initialMode);
  // What is typed in Item or Chore mode (kept when a preview goes Back).
  const [modeText, setModeText] = useState('');
  // The list picked in Item mode: kept here, because the Item panel unmounts while
  // the preview shows, so Back after a failed save returns to the same list.
  const [itemListId, setItemListId] = useState<string | null>(null);
  const [text, setText] = useState('');
  const [activeChoice, setActive] = useState(0);
  const [pending, setPending] = useState<QuickAddIntent | null>(null);
  const [saving, setSaving] = useState(false);
  const [retryMessage, setRetryMessage] = useState<string | null>(null);
  // Shopping entries saved but not confirmed yet ("Still sending…"): the preview
  // keeps them (retry state) and Confirm waits until they settle.
  const [unconfirmedMessage, setUnconfirmedMessage] = useState<string | null>(null);
  // Each wait for them belongs to this instance's current preview: Back, closing
  // and unmounting invalidate it (the command center remounts on every open).
  const [shoppingSettles] = useState(createSettlementGuard);
  useEffect(() => {
    if (!open) shoppingSettles.invalidate();
  }, [open, shoppingSettles]);
  useEffect(() => () => shoppingSettles.invalidate(), [shoppingSettles]);
  // "Sam fed Rex 12 min ago. Feed again?" for the feeding being previewed (tied to
  // that preview, so a new or edited one never inherits the answer).
  const [feedAgain, setFeedAgain] = useState<{ intent: QuickAddIntent; prompt: string } | null>(null);
  const feedAgainPromptText = feedAgain && feedAgain.intent === pending ? feedAgain.prompt : null;
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

  const quickContext = useMemo<QuickAddContext | null>(() => (currentUser ? {
    now: new Date(),
    viewer: { uid: currentUser.uid, email: currentUser.email },
    members: index.members,
    pets: index.pets,
    lists: index.lists,
    rooms: index.rooms,
    vehicles: index.vehicles,
    assets: index.assets,
  } : null), [currentUser, index.members, index.pets, index.lists, index.rooms, index.vehicles, index.assets]);

  /** Only intents the member may save (the same permissions as the module screens). */
  const permitted = useCallback((candidate: QuickAddIntent | null): QuickAddIntent | null => {
    if (!candidate || !permissions[INTENT_PERMISSION[candidate.kind]]) return null;
    if (candidate.kind === 'shopping' && !candidate.list) return null;
    return candidate;
  }, [permissions]);

  // No suggestion until the index (members, rooms, lists, pets, vehicles, assets)
  // has loaded: a sentence read against half the records could pick the wrong (or
  // no) assignee, room, list or vehicle. Each new sentence is read against the
  // current time, so "tomorrow" stays right if the palette is open past midnight.
  const intent = useMemo(
    () => (quickContext && !index.loading ? permitted(parseQuickAdd(text, { ...quickContext, now: new Date() })) : null),
    [text, quickContext, permitted, index.loading],
  );

  // AI reading (H13 fallback): only on request, for a sentence the parser could not read.
  const [aiState, setAiState] = useState<{ status: 'idle' | 'reading' | 'none' | 'error'; message?: string }>({ status: 'idle' });
  const [pendingFromAi, setPendingFromAi] = useState(false);
  const canQuickAdd = Object.values(INTENT_PERMISSION).some((permission) => permissions[permission]);
  // A bare command verb ("fed", "add ") is never an entry (QA-1): it offers the
  // pets to feed, or the Item or Chore mode, and is never sent to the AI reader.
  const bareOffer = useMemo(
    () => (index.loading ? null : bareVerbOffer(text, index.pets, (candidate) => Boolean(permissions[MODE_PERMISSION[candidate]]))),
    [text, index.loading, index.pets, permissions],
  );
  const offerAi = canQuickAdd && !index.loading && !bareOffer && shouldOfferAiParse(text, intent);

  // Each AI read belongs to one input revision. Editing the text, opening another
  // preview or going back starts a new revision, so a slower, older answer (or
  // its error) never replaces what the member is looking at now.
  const [aiRequests] = useState(createRevisionGuard);
  const invalidateAi = useCallback(() => {
    aiRequests.invalidate();
    setAiState({ status: 'idle' });
  }, [aiRequests]);

  const readWithAi = useCallback(async () => {
    const householdId = currentUser?.householdId;
    if (!householdId || !quickContext) return;
    // A second press (double click, Enter twice) while this sentence is being read
    // would discard the first, already charged answer; wait for it instead.
    if (aiRequests.isPending()) return;
    const revision = aiRequests.next();
    const context = { ...quickContext, now: new Date() };
    setAiState({ status: 'reading' });
    try {
      const { input, refs } = buildAiParseRequest(text, context);
      const output = unwrapAiActionResult(await parseCommand(input, await getAiActionContext(householdId)));
      if (!aiRequests.isCurrent(revision)) return;
      const read = permitted(intentFromAiParse(output, refs, context));
      if (!read) {
        setAiState({ status: 'none' });
        return;
      }
      aiRequests.invalidate();
      setAiState({ status: 'idle' });
      setPendingFromAi(true);
      setPending(read);
    } catch (error) {
      if (!aiRequests.isCurrent(revision)) return;
      setAiState({ status: 'error', message: error instanceof Error && error.message ? error.message : friendlyError(error) });
    } finally {
      aiRequests.settle(revision);
    }
  }, [currentUser?.householdId, quickContext, text, permitted, aiRequests]);

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
    if (bareOffer?.kind === 'feed') {
      for (const feeding of bareOffer.intents) {
        const description = describeIntent(feeding, self);
        quick.push({
          id: `quick-add-feed-${feeding.pet.id}`,
          group: 'Quick add',
          label: description.title,
          detail: description.detail,
          hint: 'Enter',
          icon: PawPrint,
          run: () => {
            invalidateAi();
            setPendingFromAi(false);
            setPending(feeding);
          },
        });
      }
    } else if (bareOffer?.kind === 'mode') {
      const target = bareOffer.mode;
      quick.push({
        id: `quick-add-mode-${target}`,
        group: 'Quick add',
        label: target === 'item' ? 'Add a shopping item…' : 'Add a chore…',
        hint: 'Enter',
        icon: target === 'item' ? ShoppingCart : CheckSquare,
        run: () => {
          invalidateAi();
          setModeText('');
          setMode(target);
        },
      });
    }
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
        run: () => {
          invalidateAi();
          setPendingFromAi(false);
          setPending(intent);
        },
      });
    }
    // Reading with AI uses a daily AI request, so Enter picks it first only when
    // nothing else matches; otherwise it is the last choice.
    const others = quick.length + records.length + pageOptions.length;
    const ai: Option[] = offerAi ? [{
      id: 'quick-add-ai',
      group: others > 0 ? 'Ask AI' : 'Quick add',
      label: `Read “${search.length > 60 ? `${search.slice(0, 57)}…` : search}” with AI`,
      detail: 'Shows a preview first; uses one AI request',
      icon: Sparkles,
      run: () => void readWithAi(),
    }] : [];
    return [...quick, ...records, ...pageOptions, ...ai];
  }, [text, permissions, index.entries, intent, self, navigate, offerAi, readWithAi, invalidateAi, bareOffer]);

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
      invalidateAi();
      setText(spoken);
      setActive(0);
      if (final) inputRef.current?.focus();
    });
  }, [voice, invalidateAi]);

  useEffect(() => {
    if (open && startVoice && voice.supported) listen();
    // Only when the palette is opened by the tab bar's long-press.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, startVoice, voice.supported]);

  useEffect(() => {
    if (!open && voice.listening) voice.stop();
  }, [open, voice]);

  // `entry` is what to save when it is not yet the state's `pending` (Item mode
  // saves on Enter: it shows the preview for the save status and calls this).
  const confirm = async (choices: PreviewChoices, entry?: QuickAddIntent) => {
    const householdId = currentUser?.householdId;
    const current = entry ?? pending;
    if (!current || !householdId || !currentUser) return;
    const lateError = (error: unknown) => toastError(error, 'Could not sync');
    setSaving(true);
    try {
      if (current.kind === 'shopping' && current.list) {
        const list = current.list;
        const outcome = await addShoppingItems(householdId, list, current.items, lateError);
        if (outcome.saved.length > 0) {
          notifyDataChanged({ module: 'shopping', householdId, listId: list.id });
          // Only a durable local copy may say "saved on this device".
          toast({ title: outcome.queued ? 'Saved, will sync' : 'Added to the list', description: outcome.queued
            ? `${outcome.saved.map((item) => item.name).join(', ')} saved on this device for ${list.name}; syncs when the connection is back.`
            : `${outcome.saved.map((item) => item.name).join(', ')} on ${list.name}.` });
          playFeedback('add');
        }
        if (outcome.unconfirmed.length > 0) {
          // Not confirmed: keep them (and any failures) in the preview, say so, and
          // decide when they settle. Closing the palette meanwhile drops nothing:
          // a late failure is still reported through lateError.
          const token = shoppingSettles.begin();
          setPending({ ...current, items: [...outcome.unconfirmed, ...outcome.failed] });
          setUnconfirmedMessage(unconfirmedShoppingMessage(outcome));
          setRetryMessage(outcome.failed.length > 0 ? `${quickAddRetryMessage(outcome.failed)} ${friendlyError(outcome.firstError)}` : null);
          void outcome.settled.then(({ failed: lateFailed }) => {
            // The toast is always delivered; the preview is updated (or the palette
            // closed) only while this is still the active preview of this instance,
            // so a palette dismissed and reopened meanwhile is never closed by it.
            const plan = planUnconfirmedSettlement(outcome.unconfirmed, outcome.failed, lateFailed, shoppingSettles.isActive(token));
            if (plan.confirmed.length > 0) {
              notifyDataChanged({ module: 'shopping', householdId, listId: list.id });
              toast({ title: 'Added to the list', description: `${plan.confirmed.map((item) => item.name).join(', ')} on ${list.name}.` });
            }
            if (plan.next === 'ignore') return;
            setUnconfirmedMessage(null);
            if (plan.next === 'close') {
              close();
              return;
            }
            setPending((current) => current && current.kind === 'shopping' ? { ...current, items: plan.remaining } : current);
            setRetryMessage(quickAddRetryMessage(plan.remaining));
          });
          return;
        }
        if (outcome.failed.length > 0) {
          // Keep only what failed, so Confirm retries those and never re-adds the saved ones.
          setPending({ ...current, items: outcome.failed });
          setRetryMessage(`${quickAddRetryMessage(outcome.failed)} ${friendlyError(outcome.firstError)}`);
          return;
        }
        close();
        return;
      } else if (current.kind === 'feeding') {
        const portion = feedingPortion(current);
        const pet = current.pet;
        const timeZone = household?.timeZone ?? null;
        const result = await logFeeding({
          householdId,
          petId: pet.id,
          amount: portion.amount,
          unit: portion.unit,
          viewer: currentUser,
          timeZone,
          confirm: feedAgainPromptText !== null,
          onLateError: lateError,
        });
        if (result.status === 'needsConfirm') {
          // Ask in the preview; Confirm then reads "Feed again".
          setFeedAgain({ intent: current, prompt: feedAgainPrompt(result, pet.name, new Date(), currentUser.uid) });
          return;
        }
        notifyDataChanged({ module: 'pets', householdId, petId: pet.id });
        const { dismiss } = toast({
          duration: FEED_UNDO_MS,
          title: result.status === 'queued' ? 'Saved on this device' : 'Feeding logged',
          description: result.status === 'queued' ? `Couldn't check whether someone else fed ${pet.name}.` : `${pet.name} has been fed.`,
          action: (
            <ToastAction
              altText={`Undo feeding for ${pet.name}`}
              onClick={async () => {
                dismiss();
                try {
                  await undoFeed({ householdId, petId: pet.id, logId: result.logId, timeZone, onLateError: lateError });
                  notifyDataChanged({ module: 'pets', householdId, petId: pet.id });
                } catch (error) {
                  toastError(error, "Couldn't undo the feeding");
                }
              }}
            >
              Undo
            </ToastAction>
          ),
        });
      } else if (current.kind === 'chore') {
        // Without chores.assign the chore can only be yours (as in the Add Chore dialog).
        const { assignee } = resolveChoreAssignee(choices.assignee ?? current.assignee, assignable, self);
        if (!assignee) throw new Error('missing-assignee');
        const room = choices.room;
        if (current.repeat) {
          const { status } = await createRepeatingChore({ householdId, viewer: currentUser, task: current.task, repeat: current.repeat, firstDay: current.dueDate, assignee, room, onLateError: lateError });
          notifyDataChanged({ module: 'chores', householdId });
          toast({ title: status === 'queued' ? 'Saved offline' : 'Repeating chore added', description: status === 'queued' ? `${current.task} will sync when you're back online.` : `${current.task}, ${describeRepeat(current.repeat)}, for ${assignee.name}.` });
        } else {
          const { choreId, status } = await createOneTimeChore({ householdId, viewer: currentUser, task: current.task, dueDate: current.dueDate, assignee, room, onLateError: lateError });
          notifyDataChanged({ module: 'chores', householdId, choreId });
          toast({ title: status === 'queued' ? 'Saved offline' : 'Chore added', description: status === 'queued' ? `${current.task} will sync when you're back online.` : `${current.task} for ${assignee.name}.` });
        }
      } else if (current.kind === 'maintenance') {
        const { status } = await logMaintenance({ householdId, title: current.title, mileage: current.mileage, target: choices.target, onLateError: lateError });
        notifyDataChanged({ module: 'maintenance', householdId });
        const where = targetName(choices.target);
        toast({ title: status === 'queued' ? 'Saved offline' : 'Maintenance logged', description: `${current.title}${where ? ` for ${where}` : ''}${current.mileage ? ` at ${current.mileage.toLocaleString()} miles` : ''}.` });
      }
      playFeedback('add');
      close();
    } catch (error) {
      toastError(error, 'Could not save');
    } finally {
      setSaving(false);
    }
  };

  // Item mode: Enter saves at once through the same shopping save as Confirm; the
  // preview shows its status (still sending, failures to retry) when there is one.
  const saveFromMode = (entry: QuickAddIntent) => {
    invalidateAi();
    setPendingFromAi(false);
    setRetryMessage(null);
    setPending(entry);
    void confirm(NO_CHOICES, entry);
  };
  const toPreview = (entry: QuickAddIntent) => {
    invalidateAi();
    setPendingFromAi(false);
    setRetryMessage(null);
    setPending(entry);
  };
  const typeInstead = () => {
    setMode(null);
    window.setTimeout(() => inputRef.current?.focus(), 0);
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    // While an IME is composing, Enter and the arrows pick and confirm candidates.
    if (isComposingKey(event)) return;
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
      <DialogContent
        hideClose
        className="top-[12%] max-w-lg translate-y-0 gap-0 overflow-hidden p-0 sm:top-[15%]"
        data-testid="command-palette"
        // Escape during IME composition cancels the composition, not the palette.
        onEscapeKeyDown={(event) => {
          if (isComposingKey(event)) event.preventDefault();
        }}
      >
        <DialogTitle className="sr-only">Search or quick add</DialogTitle>
        <DialogDescription className="sr-only">
          Search HomeHub, or type a sentence like &quot;milk and eggs to groceries&quot;, &quot;fed Maple&quot; or &quot;vacuum Friday for Sam&quot;.
        </DialogDescription>
        {pending ? (
          <QuickAddPreview
            // Remounts once the index has loaded, so its choices start from the full records.
            key={index.loading ? 'loading' : 'ready'}
            indexLoading={index.loading}
            failedSections={index.failed}
            // Back to the input and read again: the suggestion is then rebuilt from the full records.
            onRetryIndex={() => {
              invalidateAi();
              setPending(null);
              setPendingFromAi(false);
              setRetryMessage(null);
              index.retry();
              window.setTimeout(() => inputRef.current?.focus(), 0);
            }}
            intent={pending}
            self={self}
            members={assignable}
            rooms={index.rooms}
            vehicles={index.vehicles}
            assets={index.assets}
            fromAi={pendingFromAi}
            saving={saving || unconfirmedMessage !== null}
            message={retryMessage}
            status={unconfirmedMessage}
            notice={feedAgainPromptText}
            confirmLabel={feedAgainPromptText ? 'Feed again' : undefined}
            onBack={() => {
              shoppingSettles.invalidate();
              setUnconfirmedMessage(null);
              invalidateAi();
              setPending(null);
              setPendingFromAi(false);
              setRetryMessage(null);
              window.setTimeout(() => inputRef.current?.focus(), 0);
            }}
            onConfirm={(choices) => void confirm(choices)}
          />
        ) : mode === 'feeding' ? (
          <FeedingMode
            state={feedingModeState({
              canFeed: Boolean(permissions['pets.addLogs']),
              canViewPets: Boolean(permissions['pets.view']),
              loading: index.loading,
              failed: index.failed.includes('pets'),
              pets: index.pets,
            })}
            onRetry={index.retry}
            onFed={close}
            onTypeInstead={typeInstead}
          />
        ) : mode === 'item' ? (
          <ItemMode
            state={itemModeState({
              canAdd: Boolean(permissions['shopping.edit']),
              canViewLists: Boolean(permissions['shopping.view']),
              loading: index.loading,
              failed: index.failed.includes('lists'),
              lists: index.lists,
            })}
            text={modeText}
            onText={setModeText}
            listId={itemListId}
            onListId={setItemListId}
            onRetry={index.retry}
            onSave={saveFromMode}
            onOpenShopping={() => navigate('/shopping')}
            onTypeInstead={typeInstead}
          />
        ) : mode === 'chore' ? (
          <ChoreMode
            blocker={modeBlocker('chore', permissions)}
            context={quickContext}
            loading={index.loading}
            text={modeText}
            onText={setModeText}
            onPreview={toPreview}
            onTypeInstead={typeInstead}
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
                  invalidateAi();
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
            <div role="status" aria-live="polite" data-testid="palette-ai-status">
              {aiState.status === 'reading' && (
                <p className="flex items-center gap-2 border-b px-4 py-2 text-xs text-muted-foreground">
                  <Loader2 aria-hidden className="h-3.5 w-3.5 animate-spin" />
                  Reading it with AI…
                </p>
              )}
              {aiState.status === 'none' && (
                <p className="border-b px-4 py-2 text-xs text-muted-foreground">AI could not read that as something to add. Try “chore vacuum Friday” or search instead.</p>
              )}
              {aiState.status === 'error' && <p className="border-b px-4 py-2 text-xs text-destructive">{aiState.message}</p>}
            </div>
            {/* Results enter in turn when the palette opens (H12); the list is the combobox's listbox. */}
            <Stagger as="ul" id={listId} role="listbox" aria-label="Results" className="max-h-[min(60vh,24rem)] overflow-y-auto pb-2">
              {listItems.length > 0 ? listItems : (
                <li role="presentation" className="px-4 py-6 text-center text-sm text-muted-foreground">
                  {index.loading ? 'Loading…' : 'No matches. Try “add milk” or “chore vacuum tomorrow”.'}
                </li>
              )}
            </Stagger>
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
  indexLoading,
  failedSections,
  onRetryIndex,
  self,
  members,
  rooms,
  vehicles,
  assets,
  fromAi,
  saving,
  message,
  status,
  notice,
  confirmLabel = 'Confirm',
  onBack,
  onConfirm,
}: {
  intent: QuickAddIntent;
  /** The palette index is still loading: no choice can be trusted yet. */
  indexLoading: boolean;
  /** Index sections whose read failed (never treated as empty). */
  failedSections: readonly IndexSection[];
  /** Reads the index again. */
  onRetryIndex: () => void;
  self: QuickAddMember | null;
  members: QuickAddMember[];
  rooms: QuickAddRoom[];
  vehicles: QuickAddVehicle[];
  assets: QuickAddAsset[];
  /** The suggestion came from the AI reader: say so, and ask for a check. */
  fromAi: boolean;
  saving: boolean;
  /** Inline note after a partial save: which entries are left to retry. */
  message?: string | null;
  /** Entries saved but not confirmed yet ("Still sending…"); Confirm waits for them. */
  status?: string | null;
  /** A question to answer with Confirm (the feed operation's "Feed again?"). */
  notice?: string | null;
  confirmLabel?: string;
  onBack: () => void;
  onConfirm: (choices: PreviewChoices) => void;
}) {
  // A name that fits several members ("for Sam" with two Sams) is left for the member to pick.
  const ambiguous = intent.kind === 'chore' && Boolean(intent.assigneeQuery) && !intent.assignee && members.length > 1;
  const resolved = intent.kind === 'chore' && !ambiguous ? resolveChoreAssignee(intent.assignee, members, self) : { assignee: null, restricted: false };
  const [assigneeUid, setAssigneeUid] = useState(resolved.assignee?.uid ?? '');
  const [roomId, setRoomId] = useState(intent.kind === 'chore' ? intent.room?.id ?? 'general' : 'general');
  // Until the member picks one, the target follows the loaded records (the named
  // vehicle or asset, else the only vehicle for a reading), never a snapshot taken
  // before they arrived.
  const [pickedTarget, setTargetKey] = useState<string | null>(null);
  const fallbackTarget = defaultMaintenanceTarget(intent, vehicles);
  const targetKey = pickedTarget ?? (fallbackTarget ? `${fallbackTarget.kind}:${fallbackTarget.kind === 'vehicle' ? fallbackTarget.vehicle.id : fallbackTarget.asset.id}` : '');
  const assignee = members.find((member) => member.uid === assigneeUid) ?? (self?.uid === assigneeUid ? self : null);
  const room = rooms.find((candidate) => candidate.id === roomId) ?? null;
  const target: MaintenanceTarget | null = (() => {
    const [kind, id] = targetKey.split(':');
    if (kind === 'vehicle') {
      const vehicle = vehicles.find((candidate) => candidate.id === id);
      return vehicle ? { kind: 'vehicle', vehicle } : null;
    }
    if (kind === 'asset') {
      const asset = assets.find((candidate) => candidate.id === id);
      return asset ? { kind: 'asset', asset } : null;
    }
    return null;
  })();
  // A mileage belongs to a vehicle: with vehicles to choose from, pick one first.
  const needsVehicle = !indexLoading && intent.kind === 'maintenance' && intent.mileage !== null && vehicles.length > 0 && target?.kind !== 'vehicle';
  const blocker = quickAddConfirmBlocker({ intent, indexLoading, vehicleCount: vehicles.length, chosenTarget: target, chosenAssignee: assignee, failedSections });
  const indexFailed = !indexLoading && failedSectionsFor(intent, failedSections).length > 0;
  const shown: QuickAddIntent = intent.kind === 'chore'
    ? { ...intent, assignee: assignee ?? resolved.assignee, room }
    : intent.kind === 'maintenance' ? { ...intent, target } : intent;
  const description = describeIntent(shown, self);
  const note = intent.kind === 'maintenance' ? mileageNote(intent.mileage, target) : null;
  const confirmRef = useRef<HTMLButtonElement>(null);
  const firstFieldRef = useRef<HTMLSelectElement>(null);
  useEffect(() => {
    // The vehicle comes first when it must be chosen; otherwise Confirm has focus.
    if (needsVehicle) firstFieldRef.current?.focus();
    else confirmRef.current?.focus();
    // Only on open.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const fieldClass = 'h-10 w-full rounded-md border border-input bg-background px-3 text-sm';

  return (
    <div className="p-4" data-testid="quick-add-preview">
      <p className="text-xs font-medium text-muted-foreground">Check before saving</p>
      <div className="mt-2 rounded-lg border bg-muted/40 p-3">
        <p className="font-medium">{description.title}</p>
        <p className="text-sm text-muted-foreground">{description.detail}</p>
      </div>
      {intent.kind === 'chore' && intent.repeatNote && (
        <p className="mt-2 text-sm text-muted-foreground" data-testid="quick-add-repeat-note">{intent.repeatNote}</p>
      )}
      {fromAi && (
        <p className="mt-2 flex items-center gap-1.5 text-xs text-muted-foreground" data-testid="quick-add-ai-marker">
          <Sparkles aria-hidden className="h-3 w-3" />
          Read by AI. Check the details before you confirm.
        </p>
      )}
      {resolved.restricted && (
        <p className="mt-3 text-sm text-muted-foreground" data-testid="quick-add-assignee-restricted">
          You can only assign chores to yourself, so this one will be yours.
        </p>
      )}
      {intent.kind === 'chore' && members.length > 1 && (
        <label className="mt-3 block text-sm">
          <span className="mb-1 block text-muted-foreground">Assign to</span>
          <select value={assigneeUid} onChange={(event) => setAssigneeUid(event.target.value)} className={fieldClass} aria-invalid={(ambiguous && !assignee) || undefined}>
            {assigneeUid === '' && <option value="" disabled>Choose who</option>}
            {members.map((member) => (
              <option key={member.uid} value={member.uid}>{member.name}</option>
            ))}
          </select>
        </label>
      )}
      {intent.kind === 'chore' && rooms.length > 0 && (
        <label className="mt-3 block text-sm">
          <span className="mb-1 block text-muted-foreground">Room</span>
          <select value={roomId} onChange={(event) => setRoomId(event.target.value)} className={fieldClass}>
            <option value="general">Around the house</option>
            {rooms.map((candidate) => (
              <option key={candidate.id} value={candidate.id}>{candidate.name}</option>
            ))}
          </select>
        </label>
      )}
      {intent.kind === 'maintenance' && (vehicles.length > 0 || (intent.mileage === null && assets.length > 0)) && (
        <label className="mt-3 block text-sm">
          <span className="mb-1 block text-muted-foreground">{intent.mileage !== null ? 'Vehicle' : 'For'}</span>
          <select ref={firstFieldRef} value={targetKey} onChange={(event) => setTargetKey(event.target.value)} className={fieldClass} aria-invalid={needsVehicle || undefined}>
            {intent.mileage !== null ? <option value="" disabled>Choose a vehicle</option> : <option value="">General (no vehicle or asset)</option>}
            {vehicles.map((vehicle) => (
              <option key={vehicle.id} value={`vehicle:${vehicle.id}`}>{vehicle.name}</option>
            ))}
            {intent.mileage === null && assets.map((asset) => (
              <option key={asset.id} value={`asset:${asset.id}`}>{asset.name}</option>
            ))}
          </select>
        </label>
      )}
      {blocker && (
        <p role="status" className={cn('mt-3 text-sm', indexFailed ? 'text-destructive' : 'text-muted-foreground')} data-testid="quick-add-blocker">{blocker}</p>
      )}
      {indexFailed && (
        <Button type="button" variant="outline" size="sm" className="mt-2" onClick={onRetryIndex} data-testid="quick-add-retry-index">
          Try again
        </Button>
      )}
      {!indexLoading && !indexFailed && intent.kind === 'maintenance' && intent.mileage !== null && vehicles.length === 0 && (
        <p className="mt-3 text-sm text-muted-foreground">No vehicles yet, so this is a general log with the reading in its notes.</p>
      )}
      {note && <p className="mt-3 text-sm text-warning" data-testid="quick-add-mileage-note">{note}</p>}
      {status && <p role="status" className="mt-3 text-sm text-muted-foreground" data-testid="quick-add-unconfirmed">{status}</p>}
      {message && <p role="alert" className="mt-3 text-sm text-destructive" data-testid="quick-add-retry">{message}</p>}
      {notice && <p role="alert" className="mt-3 text-sm text-foreground" data-testid="quick-add-feed-again">{notice}</p>}
      <div className="mt-4 flex justify-between gap-2">
        <Button type="button" variant="ghost" onClick={onBack} disabled={saving}>
          <ArrowLeft aria-hidden className="mr-2 h-4 w-4" />
          Back
        </Button>
        <Button
          ref={confirmRef}
          type="button"
          onClick={() => onConfirm({ assignee, room, target })}
          disabled={saving || blocker !== null}
          data-testid="quick-add-confirm"
        >
          {saving && <Loader2 aria-hidden className="mr-2 h-4 w-4 animate-spin" />}
          {confirmLabel}
        </Button>
      </div>
    </div>
  );
}
