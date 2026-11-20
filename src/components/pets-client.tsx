'use client';

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { collection, onSnapshot, type QuerySnapshot } from 'firebase/firestore';
import { PlusCircle } from 'lucide-react';
import { useAuth } from '@/hooks/use-auth';
import { useToast } from '@/hooks/use-toast';
import { db } from '@/lib/firebase';
import type { ResilientHandle } from '@/lib/dashboard/resilient-listener';
import { petListenerKey, petSnapshotListener, staleNoticeText } from '@/lib/pets/live-listener';
import { useSettledPetAccess } from './pets/pet-access';
import type { PetProfile } from '@/lib/pets/types';
import { FEED_SHORTCUT_PARAM, loggerName, petHref, quickFeedDecision, wantsQuickFeed } from '@/lib/pets/care';
import { Stagger, StaggerItem } from './motion/stagger';
import { FeedPickerDialog } from './pets/feed-picker-dialog';
import { AddPetDialog } from './add-pet-dialog';
import { DeletePetAlert } from './delete-pet-alert';
import { EditPetDialog } from './edit-pet-dialog';
import { EmptyState } from './empty-state';
import { Button } from './ui/button';
import { cn } from '@/lib/utils';
import { LivingPetCard, type PetAttention } from './pets/living-pet-card';
import { PETS_GRID, PetsGridSkeleton } from './pets/pets-skeleton';
import { PetsPageHeader } from './pets/pets-page-header';
import { createPet, deletePet, updatePet } from './pets/pet-profile-api';
import { returnFocusToPet } from './pets/focus';
import type { PetFields } from './pets/pet-form';
import type { PetPhotoChoice } from './pets/pet-photo-draft';
import { DuplicatePetNameError, otherPetNames, petDeletedMessage } from '@/lib/pets/profile';
import { boardRowPlan } from '@/lib/pets/board';
import { usePetsLayout } from './pets/use-pets-layout';

const GRID = PETS_GRID;
/**
 * Space kept under the board: the bottom padding of the board's ancestors (the
 * page's `py-8`, in rem, so it grows with the text size), so a board that fits
 * leaves the page unscrolled at every text scale. Read from the layout, never
 * from the board's own height, so measuring never feeds back into itself.
 */
function bottomPaddingBelow(element: HTMLElement): number {
  let total = 0;
  for (let node = element.parentElement; node && node !== document.body; node = node.parentElement) {
    total += parseFloat(getComputedStyle(node).paddingBottom) || 0;
  }
  return Math.ceil(total);
}

/**
 * The board (PE-9, D-P1, D-P14): at least as tall as the screen
 * from its top to the bottom of the viewport. One to three pets share one row
 * (one or two grow to use it, PE-9d), four are two by two, five or six three by
 * two. Every row is at least as tall as its tallest card's content
 * (`minmax(min-content, 1fr)`), so a card never scrolls inside itself and
 * nothing is clipped: when the cards need more than the screen (many pets, a
 * short window, large text) the board grows and the page scrolls as a whole.
 * Past six pets each row keeps the six-up height.
 */
function PetsBoard({ count, children }: { count: number; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [height, setHeight] = useState<number | null>(null);
  // Measured after every render (the attention strip above it may come and go) and on resize.
  useLayoutEffect(() => {
    const measure = () => {
      const element = ref.current;
      if (!element) return;
      const top = element.getBoundingClientRect().top + window.scrollY;
      const next = Math.max(280, Math.floor(window.innerHeight - top - bottomPaddingBelow(element)));
      setHeight((previous) => (previous === next ? previous : next));
    };
    measure();
    window.addEventListener('resize', measure);
    // Content above the board that comes and goes without re-rendering it (the
    // needs-attention strip once the cards report) resizes its parent: measure again then.
    const parent = ref.current?.parentElement;
    const observer = parent && typeof ResizeObserver !== 'undefined' ? new ResizeObserver(measure) : null;
    if (parent) observer?.observe(parent);
    return () => {
      window.removeEventListener('resize', measure);
      observer?.disconnect();
    };
  });
  const grid = boardRowPlan(count, height);
  return (
    <div
      ref={ref}
      className="grid gap-4"
      data-testid="pets-board"
      style={{
        gridTemplateColumns: `repeat(${grid.columns}, minmax(0, 1fr))`,
        gridTemplateRows: `repeat(${grid.rows}, minmax(min-content, 1fr))`,
        minHeight: grid.minHeight ?? undefined,
      }}
    >
      {children}
    </div>
  );
}

/**
 * Needs-attention strip (PE-26): pets with a meal past its slot time (due, or
 * missed earlier today) or an overdue medication, from the same shared status
 * the cards show (PE-22h). Hidden when nothing needs attention; a pet whose data
 * is loading or failed is never listed. The cards below keep their order.
 */
function AttentionStrip({ pets, attention, compact }: { pets: PetProfile[]; attention: Record<string, PetAttention>; compact?: boolean }) {
  const listed = pets.filter((pet) => attention[pet.id]);
  if (listed.length === 0) return null;
  return (
    // On the board (`compact`) the title and the pets share one line, so the cards keep their height.
    <section
      aria-labelledby="pets-attention-title"
      className={cn('rounded-lg border border-warning/60 bg-warning/10', compact ? 'mb-3 flex flex-wrap items-center gap-x-3 gap-y-2 px-3 py-2' : 'mb-4 p-3')}
      data-testid="pets-attention"
    >
      <h2 id="pets-attention-title" className="text-sm font-semibold text-foreground">Needs attention</h2>
      <ul className={cn('flex min-w-0 flex-wrap gap-2', !compact && 'mt-2')}>
        {listed.map((pet) => {
          const item = attention[pet.id];
          return (
            <li key={pet.id} className="min-w-0 max-w-full">
              <Link
                href={petHref(pet.id)}
                className="inline-flex min-h-[var(--target-min)] max-w-full items-center rounded-full border border-border bg-card px-3 py-1 text-left text-sm text-foreground transition-ui hover:bg-muted"
                data-testid={`pets-attention-${pet.id}`}
              >
                {/* The whole name, wrapping between words (PE-26; never cut to "A…" at 130% text). */}
                <span className="min-w-0 break-words">
                  <span className="font-semibold">{pet.name}</span>: {[item.meal, item.medication].filter(Boolean).join(' · ')}
                </span>
              </Link>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

export function PetsClient() {
  const { currentUser, currentMember, permissions, household, loading: authLoading, householdLoading } = useAuth();
  const { toast, toastError } = useToast();
  const householdId = currentUser?.householdId ?? null;
  const canEdit = Boolean(permissions['pets.editProfiles']);

  // Keyed by household so a household switch never shows the previous pets.
  // `failed`: the list could not be read (`retrying`: it resubscribes on its own;
  // `unauthorized`: access was refused, so no "Try again" is offered, PE-18c).
  // Keyed by the listener (household, member, pets.view), so access returning starts a fresh read.
  // On the settled access (`useSettledPetAccess`): nothing subscribes until membership has
  // loaded, so permissions settling after the first render never re-key the list (which
  // would drop the loaded grid back to the skeleton and remount every card).
  const access = useSettledPetAccess();
  const listKey = access ? petListenerKey(householdId ? `${householdId}/pets` : null, access) : null;
  const [snapshot, setSnapshot] = useState<{ key: string | null; pets: PetProfile[]; loaded: boolean; failed: false | 'retrying' | 'unauthorized' }>({
    key: null,
    pets: [],
    loaded: false,
    failed: false,
  });
  const listHandle = useRef<ResilientHandle | null>(null);
  // The pet whose menu opened Edit or Delete: focus returns to its actions button (PE-20e).
  const menuPet = useRef<string | null>(null);
  const backToMenu = (event: Event) => returnFocusToPet(menuPet.current)(event);
  const [addOpen, setAddOpen] = useState(false);
  const [petToEdit, setPetToEdit] = useState<PetProfile | null>(null);
  const [petToDelete, setPetToDelete] = useState<PetProfile | null>(null);

  // Live pet list: edits from other members and devices appear without a refresh.
  // A resilient listener (PE-8g): a failed read resubscribes with bounded backoff
  // and on `online` / page visible; already loaded pets stay while it retries.
  useEffect(() => {
    if (!householdId || !listKey) return;
    const handle = petSnapshotListener<QuerySnapshot>(
      (next, error) => onSnapshot(collection(db, 'households', householdId, 'pets'), { includeMetadataChanges: true }, next, error),
      {
        next: (result) => {
          const next = result.docs.map((entry) => ({ id: entry.id, ...entry.data() }) as PetProfile);
          setSnapshot({ key: listKey, pets: next.sort((a, b) => a.name.localeCompare(b.name)), loaded: true, failed: false });
        },
        status: (status) => {
          if (status.kind === 'live') return;
          console.error('Error loading pets:', status.error);
          setSnapshot((previous) => previous.key === listKey && previous.loaded
            ? { ...previous, failed: status.kind }
            : { key: listKey, pets: [], loaded: false, failed: status.kind });
        },
      },
    );
    listHandle.current = handle;
    return () => {
      handle.stop();
      if (listHandle.current === handle) listHandle.current = null;
    };
    // Recreated when the member or their pets.view changes: a refused list recovers when access returns.
  }, [householdId, listKey]);

  const ready = snapshot.key === listKey && (snapshot.loaded || snapshot.failed !== false);
  const loading = Boolean(householdId) && !ready;
  const pets = useMemo(() => (ready ? snapshot.pets : []), [ready, snapshot.pets]);
  const loadFailed = ready && !snapshot.loaded ? snapshot.failed : false;

  const existingNames = useMemo(() => pets.map((pet) => pet.name), [pets]);

  // Each card reports its own attention (from its shared status); the strip lists them in card order.
  const [attention, setAttention] = useState<{ householdId: string | null; byPet: Record<string, PetAttention> }>({ householdId: null, byPet: {} });
  const reportAttention = useCallback((petId: string, item: PetAttention | null) => {
    setAttention((previous) => {
      const base = previous.householdId === householdId ? previous.byPet : {};
      if (!item && !(petId in base)) return previous.householdId === householdId ? previous : { householdId, byPet: base };
      const byPet = { ...base };
      if (item) byPet[petId] = item;
      else delete byPet[petId];
      return { householdId, byPet };
    });
  }, [householdId]);
  const attentionByPet = attention.householdId === householdId ? attention.byPet : {};

  // "Log feeding" home-screen shortcut (`/pets?feed=1`): once both the pet list and
  // the member's permissions have loaded, open the feeding picker (straight to the
  // confirm step with one pet) or ignore the request, then drop the param so a
  // reload or Back does not reopen it. Nothing is decided, or removed, before that.
  const searchParams = useSearchParams();
  const feedRequested = wantsQuickFeed(searchParams);
  const canFeed = Boolean(permissions['pets.addLogs']);
  const [feedPickerOpen, setFeedPickerOpen] = useState(false);
  const [handledFeedRequest, setHandledFeedRequest] = useState(false);
  const feedDecision = quickFeedDecision({
    requested: feedRequested && !handledFeedRequest,
    permissionsReady: !authLoading && !householdLoading && Boolean(currentMember),
    petsReady: ready && !loading,
    canFeed,
    petCount: pets.length,
  });
  if (feedDecision === 'open' || feedDecision === 'ignore') {
    setHandledFeedRequest(true);
    if (feedDecision === 'open') setFeedPickerOpen(true);
  }
  useEffect(() => {
    if (!handledFeedRequest || !feedRequested) return;
    const url = new URL(window.location.href);
    url.searchParams.delete(FEED_SHORTCUT_PARAM);
    window.history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`);
  }, [handledFeedRequest, feedRequested]);

  // Meal times are confirmed by the signed-in member, on the household's day (PE-22k).
  const confirmer = currentUser ? { uid: currentUser.uid, name: loggerName(currentUser), timeZone: household?.timeZone ?? null } : undefined;

  const handleAddPet = async (petId: string, fields: PetFields, photoFile: File | null): Promise<boolean | 'name-taken'> => {
    if (!householdId) return false;
    try {
      await createPet(householdId, petId, fields, photoFile, confirmer);
      toast({ title: 'Pet added', description: `${fields.name} has joined the household.` });
      return true;
    } catch (error) {
      if (error instanceof DuplicatePetNameError) return 'name-taken';
      console.error('Error adding pet:', error);
      toastError(error, "Couldn't add the pet");
      return false;
    }
  };

  const handleUpdatePet = async (fields: PetFields, photo: PetPhotoChoice): Promise<boolean | 'name-taken'> => {
    if (!householdId || !petToEdit) return false;
    try {
      // A rename keeps the pet's id and every history under it (PE-30b).
      await updatePet(householdId, petToEdit.id, fields, photo, petToEdit.name, confirmer);
      toast({ title: 'Pet updated', description: `${fields.name}'s details are saved.` });
      setPetToEdit(null);
      return true;
    } catch (error) {
      if (error instanceof DuplicatePetNameError) return 'name-taken';
      console.error('Error updating pet:', error);
      toastError(error, "Couldn't update the pet");
      return false;
    }
  };

  const handleDeletePet = async () => {
    const target = petToDelete;
    setPetToDelete(null);
    if (!householdId || !target) return;
    try {
      // On the server: the pet, its histories, notes, weights, photos and open reminders (D-P12).
      const status = await deletePet(householdId, target.id);
      toast({ title: 'Pet deleted', description: petDeletedMessage(target.name, status) });
    } catch (error) {
      console.error('Error deleting pet:', error);
      toastError(error, "Couldn't delete the pet");
    }
  };

  // PE-13b: Add Pet sits in the header row on every screen, never a full-width button above the cards.
  const addButton = canEdit ? (
    <Button onClick={() => setAddOpen(true)} className="w-auto">
      <PlusCircle className="mr-2" /> Add Pet
    </Button>
  ) : null;

  // The view for this screen (D-P1, PE-13a).
  const layout = usePetsLayout();

  const card = (pet: PetProfile, index: number) => (
    <LivingPetCard
      pet={pet}
      householdId={householdId!}
      canEdit={canEdit}
      onEdit={(target) => { menuPet.current = target.id; setPetToEdit(target); }}
      onDelete={(target) => { menuPet.current = target.id; setPetToDelete(target); }}
      priority={index === 0}
      index={index}
      layout={layout}
      roomy={layout === 'board' && pets.length <= 2}
      onAttention={reportAttention}
    />
  );

  return (
    <div>
      {/* The board drops the subtitle (PE-9f): the space goes to the pets. */}
      <PetsPageHeader action={addButton} subtitle={layout !== 'board'} />
      {ready && snapshot.loaded && snapshot.failed && (
        <p role="status" className="-mt-4 mb-4 text-sm text-muted-foreground" data-testid="pets-list-stale">
          {staleNoticeText(snapshot.failed === 'unauthorized' ? 'access-changed' : 'reconnecting', 'the pet list')}
        </p>
      )}

      {canEdit && (
        <AddPetDialog open={addOpen} onOpenChange={setAddOpen} existingNames={existingNames} onAddPet={handleAddPet} />
      )}
      {canFeed && householdId && (
        <FeedPickerDialog open={feedPickerOpen} onOpenChange={setFeedPickerOpen} pets={pets} householdId={householdId} />
      )}
      <EditPetDialog pet={petToEdit} otherNames={petToEdit ? otherPetNames(pets, petToEdit.id) : undefined} onUpdatePet={handleUpdatePet} onOpenChange={(isOpen) => !isOpen && setPetToEdit(null)} onCloseAutoFocus={backToMenu} />
      <DeletePetAlert
        isOpen={!!petToDelete}
        petName={petToDelete?.name}
        onConfirm={handleDeletePet}
        onCancel={() => setPetToDelete(null)}
        onCloseAutoFocus={backToMenu}
      />

      {loading ? (
        <div role="status" aria-busy="true" aria-label="Loading pets">
          <PetsGridSkeleton />
        </div>
      ) : pets.length > 0 && householdId ? (
        <>
        {/* PE-26a: the strip heads /pets in every view, the board included (the board measures its height below it). */}
        <AttentionStrip pets={pets} attention={attentionByPet} compact={layout === 'board'} />
        {layout === 'board' ? (
          <PetsBoard count={pets.length}>
            {pets.map((pet, index) => <div key={pet.id} className="min-w-0">{card(pet, index)}</div>)}
          </PetsBoard>
        ) : layout === 'rows' ? (
          <Stagger className="flex flex-col gap-3" data-testid="pets-rows">
            {pets.map((pet, index) => <StaggerItem key={pet.id} className="min-w-0">{card(pet, index)}</StaggerItem>)}
          </Stagger>
        ) : (
          <Stagger className={GRID}>
            {pets.map((pet, index) => <StaggerItem key={pet.id} className="min-w-0">{card(pet, index)}</StaggerItem>)}
          </Stagger>
        )}
        </>
      ) : loadFailed === 'unauthorized' ? (
        <EmptyState
          kind="pets"
          title="Pets aren't available to you"
          description="Your household role doesn't include viewing pets. Ask an owner or admin if you need access."
        />
      ) : loadFailed ? (
        <EmptyState
          kind="pets"
          title="Pets are unavailable right now"
          description="We couldn't load your pets. HomeHub keeps trying; check your connection or try again now."
          action={{ label: 'Try again', onClick: () => listHandle.current?.retryNow() }}
        />
      ) : (
        <EmptyState
          kind="pets"
          title="No pets yet"
          description={
            canEdit
              ? 'Add your first pet to track feedings, medication and care in one place.'
              : 'Pets your household adds will show up here.'
          }
          action={canEdit ? { label: 'Add your first pet', icon: <PlusCircle className="mr-2 h-4 w-4" />, onClick: () => setAddOpen(true) } : undefined}
        />
      )}
    </div>
  );
}
