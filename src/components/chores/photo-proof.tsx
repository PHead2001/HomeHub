'use client';

import { useEffect, useMemo, useState } from 'react';
import { format } from 'date-fns';
import { Camera, Check, Loader2, Undo2 } from 'lucide-react';
import { getDownloadURL, ref as storageRef, uploadBytes } from 'firebase/storage';
import { doc, collection } from 'firebase/firestore';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { FieldError } from '@/components/field-error';
import { db, storage } from '@/lib/firebase';
import { downscaleErrorCopy, downscaleImage } from '@/lib/images/downscale';
import { MAX_PROOF_BYTES, proofPath, readProof } from '@/lib/chores/proof';
import { completionFailureMessage, reviewProofOnServer, submitProofOnServer } from '@/lib/chores/complete-client';
import type { ChoreRecord } from '@/lib/chores/dates';

const SUBMIT_REFUSED: Record<string, string> = {
  missing: 'That chore is gone.',
  completed: 'That chore is already done.',
  early: "That chore isn't due yet.",
  'not-required': 'That chore does not need a photo. Tick it instead.',
  'photo-missing': "The photo didn't arrive. Try again.",
  'already-pending': 'A photo is already waiting for a parent.',
};

const extensionOf = (type: string) => (type === 'image/png' ? 'png' : type === 'image/webp' ? 'webp' : 'jpg');

/**
 * CH-30: a kid's Done on a chore that asks for a photo opens this. The photo is shrunk
 * (1600 px, 5 MB at most), uploaded into the chore's proof folder marked as theirs, and
 * sent to the server, which leaves the chore waiting for a parent.
 */
export function PhotoProofDialog({ chore, householdId, uid, onClose, onSent }: {
  chore: ChoreRecord | null;
  householdId: string;
  uid: string;
  onClose: () => void;
  onSent: (chore: ChoreRecord) => void;
}) {
  const [file, setFile] = useState<File | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const preview = useMemo(() => (file ? URL.createObjectURL(file) : null), [file]);
  useEffect(() => () => { if (preview) URL.revokeObjectURL(preview); }, [preview]);
  const close = () => { if (busy) return; setFile(null); setError(null); onClose(); };

  const send = async () => {
    if (!chore || !file) return setError('Take or choose a photo first.');
    setBusy(true);
    setError(null);
    try {
      const shrunk = await downscaleImage(file, { maxEdge: 1600, maxBytes: MAX_PROOF_BYTES, force: true });
      if (!shrunk.ok) return setError(downscaleErrorCopy(shrunk.reason, MAX_PROOF_BYTES));
      // A Firestore auto-id is a convenient random name part.
      const path = proofPath(householdId, chore.id, uid, doc(collection(db, 'ids')).id, extensionOf(shrunk.file.type));
      await uploadBytes(storageRef(storage, path), shrunk.file, { contentType: shrunk.file.type, customMetadata: { uploadedByUid: uid } });
      const result = await submitProofOnServer(householdId, chore.id, path);
      if (!result.ok) return setError(completionFailureMessage(result, 'complete'));
      if (result.data.status === 'refused') return setError(SUBMIT_REFUSED[result.data.refused] ?? "Couldn't send the photo.");
      setFile(null);
      onSent(chore);
      onClose();
    } catch {
      setError("Couldn't send the photo. Check the connection and try again.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={chore !== null} onOpenChange={open => { if (!open) close(); }}>
      <DialogContent className="flex flex-col overflow-hidden">
        <DialogHeader>
          <DialogTitle>Show it&apos;s done</DialogTitle>
          <DialogDescription>{chore ? `${chore.task} needs a photo. A parent looks at it, and then it counts.` : null}</DialogDescription>
        </DialogHeader>
        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto">
          <label className="flex min-h-[var(--target-min)] cursor-pointer items-center justify-center gap-2 rounded-lg border border-dashed p-4 text-sm font-medium hover:bg-accent">
            <Camera aria-hidden className="h-5 w-5" />
            {file ? 'Take another photo' : 'Take or choose a photo'}
            <input
              type="file"
              accept="image/*"
              capture="environment"
              className="sr-only"
              aria-describedby={error ? 'chore-proof-photo-error' : undefined}
              onChange={event => { setFile(event.target.files?.[0] ?? null); setError(null); }}
            />
          </label>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          {preview && <img src={preview} alt="The photo to send" className="max-h-64 w-full rounded-lg object-contain" />}
          <FieldError id="chore-proof-photo">{error}</FieldError>
        </div>
        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={close} disabled={busy}>Cancel</Button>
          <Button onClick={() => void send()} disabled={busy || !file}>{busy && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}Send photo</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * CH-30: for members who may edit chores, the photos kids sent, oldest first: look at
 * each, then Approve (the chore is completed for the kid, at the time they sent it) or
 * Send back (it stays open). The photo is loaded only when asked for.
 */
export function ProofReviewList({ chores, householdId, currentUid, onReviewed }: {
  chores: readonly ChoreRecord[];
  householdId: string;
  currentUid: string;
  onReviewed: (title: string, description?: string, failed?: boolean) => void;
}) {
  const [urls, setUrls] = useState<Record<string, string | null>>({});
  const [busy, setBusy] = useState<string | null>(null);
  if (chores.length === 0) return null;
  const show = async (chore: ChoreRecord, path: string) => {
    try {
      const url = await getDownloadURL(storageRef(storage, path));
      setUrls(previous => ({ ...previous, [chore.id]: url }));
    } catch {
      setUrls(previous => ({ ...previous, [chore.id]: null }));
    }
  };
  const review = async (chore: ChoreRecord, approve: boolean) => {
    setBusy(chore.id);
    try {
      const result = await reviewProofOnServer(householdId, chore.id, approve);
      if (!result.ok) return onReviewed(completionFailureMessage(result, 'complete'), undefined, true);
      const outcome = result.data;
      if (outcome.status === 'approved') onReviewed('Approved', `${chore.task} is done and its points are counted.`);
      else if (outcome.status === 'sent-back') onReviewed('Sent back', `${chore.task} is open again.`);
      else if (outcome.status === 'refused') onReviewed("Couldn't review", outcome.refused === 'own-photo' ? 'Someone else has to approve your own photo.' : 'It changed meanwhile.', true);
    } finally {
      setBusy(null);
    }
  };
  return (
    <section aria-labelledby="chores-proofs-title" className="mb-3 rounded-lg border bg-background p-3" data-testid="chores-proof-review">
      <h3 id="chores-proofs-title" className="text-sm font-semibold">Photos to check ({chores.length})</h3>
      <ul className="mt-2 space-y-2">
        {chores.map(chore => {
          const proof = readProof(chore.proof)!;
          const url = urls[chore.id];
          const own = proof.submittedByUid === currentUid;
          return (
            <li key={chore.id} className="rounded-md border p-2">
              <p className="text-sm font-medium">{chore.task}</p>
              <p className="text-xs text-muted-foreground">{proof.submittedByName || 'A kid'} sent a photo · {format(new Date(proof.submittedAt), 'EEE, MMM d, h:mm a')}</p>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              {url && <img src={url} alt={`Photo for ${chore.task}`} className="mt-2 max-h-56 w-full rounded-md object-contain" />}
              {url === null && <p className="mt-1 text-xs text-destructive">The photo could not be loaded.</p>}
              <div className="mt-2 flex flex-wrap gap-2">
                {proof.photoPath && url === undefined && <Button size="sm" variant="outline" onClick={() => void show(chore, proof.photoPath!)}>View photo</Button>}
                {!own && (
                  <>
                    <Button size="sm" disabled={busy === chore.id} onClick={() => void review(chore, true)}><Check className="mr-1 h-4 w-4" /> Approve</Button>
                    <Button size="sm" variant="ghost" disabled={busy === chore.id} onClick={() => void review(chore, false)}><Undo2 className="mr-1 h-4 w-4" /> Send back</Button>
                  </>
                )}
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
