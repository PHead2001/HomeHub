'use client';

import * as React from 'react';
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { Camera, FileText, ImageOff, Loader2, Paperclip, Sparkles, X } from 'lucide-react';
import { readMaintenanceReceipt } from '@/ai/flows/read-receipt-flow';
import { AiClientError, getAiActionContext, unwrapAiActionResult } from '@/ai/client';
import { FieldError } from '@/components/field-error';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';
import { useAuth } from '@/hooks/use-auth';
import { downscaleImage } from '@/lib/images/downscale';
import { RECEIPT_ACCEPT, checkMaintenanceFile, isHeicType } from '@/lib/maintenance/attachments';
import {
  RECEIPT_FIELD_LABELS, RECEIPT_READ_MAX_BYTES, receiptImagePreparation, RECEIPT_READ_TIMEOUT, withReceiptReadDeadline, RECEIPT_READ_MAX_EDGE, createReceiptReadGuard, receiptFieldsKept,
  sanitizeReceiptFields, type ReceiptFields,
} from '@/lib/maintenance/receipt-fill';
import { OFFLINE_MESSAGE } from './maintenance-action-client';
import { formatCurrency, formatFileSize } from './page-model';
import { receiptStaging, type StagedReceipt } from './receipt-staging';

const MAX_STAGED = 5;

/** Reads a file as base64 (no data: prefix) from its bytes: a plain promise, no reader events. */
const toBase64 = async (file: Blob) => {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = '';
  for (let start = 0; start < bytes.length; start += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(start, start + 0x8000));
  }
  return btoa(binary);
};


type ReadState =
  | { kind: 'idle' }
  | { kind: 'reading' }
  | { kind: 'result'; fields: ReceiptFields; accepted: Record<keyof ReceiptFields, boolean> }
  | { kind: 'error'; message: string };

/**
 * The log form's "Receipt / photos" (MA-16, MA-30). Photos (camera on phones) or PDFs are checked
 * like storage.rules, staged, and uploaded to the log once it is saved. "Read receipt" asks the
 * AI reader for cost, provider and parts; the result is shown for correction and fills only the
 * fields the person has not typed in, after "Use these". A late answer (the receipt changed,
 * was removed, or the form closed) is ignored; a failed reading leaves the form as it was and
 * the receipt attached.
 */
export function ReceiptPicker({
  editedFields,
  onApply,
  disabled,
}: {
  /** Fields the person has typed in (never overwritten). */
  editedFields: () => Partial<Record<'cost' | 'serviceProvider' | 'partsUsed', boolean>>;
  onApply: (fields: ReceiptFields, accepted: Record<keyof ReceiptFields, boolean>) => void;
  disabled?: boolean;
}) {
  const { currentUser } = useAuth();
  const staged = useSyncExternalStore(receiptStaging.subscribe, receiptStaging.current, () => [] as readonly StagedReceipt[]);
  const [error, setError] = useState('');
  const [read, setRead] = useState<ReadState>({ kind: 'idle' });
  const guard = useRef(createReceiptReadGuard());
  const previews = useMemo(() => new Map(staged.map(entry => {
    const check = checkMaintenanceFile(entry.file);
    const image = check.ok && check.image && !check.heic;
    return [entry.key, { url: image ? URL.createObjectURL(entry.file) : null, heic: check.ok && check.heic, pdf: check.ok && check.contentType === 'application/pdf' }];
  })), [staged]);
  useEffect(() => () => { for (const preview of previews.values()) if (preview.url) URL.revokeObjectURL(preview.url); }, [previews]);
  // Opening the form starts over; closing it makes any answer still on its way stale. Each mount
  // gets a fresh guard: a closed guard never reopens, and React runs mount, cleanup and mount
  // again in development (Strict Mode), which would otherwise leave every reading "stale" and the
  // form stuck on "Reading receipt…".
  useEffect(() => {
    receiptStaging.clear();
    const current = createReceiptReadGuard();
    guard.current = current;
    return () => current.close();
  }, []);

  const add = (files: FileList | null) => {
    if (!files || files.length === 0) return;
    const accepted: StagedReceipt[] = [];
    const problems: string[] = [];
    for (const file of Array.from(files)) {
      const check = checkMaintenanceFile(file);
      if (!check.ok) problems.push(check.message);
      else accepted.push({ key: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, file });
    }
    const next = [...staged, ...accepted].slice(0, MAX_STAGED);
    if (staged.length + accepted.length > MAX_STAGED) problems.push(`Up to ${MAX_STAGED} files per log.`);
    setError(problems.join(' '));
    if (accepted.length > 0) {
      // A new receipt: an earlier reading no longer applies.
      guard.current.cancel();
      setRead({ kind: 'idle' });
    }
    receiptStaging.set(next);
  };

  const remove = (key: string) => {
    guard.current.cancel();
    setRead({ kind: 'idle' });
    receiptStaging.set(staged.filter(entry => entry.key !== key));
  };

  const readable = staged.find(entry => {
    const check = checkMaintenanceFile(entry.file);
    return check.ok && (check.contentType === 'application/pdf' || check.image);
  });

  const readReceipt = async () => {
    const entry = readable;
    const householdId = currentUser?.householdId;
    if (!entry || !householdId) return;
    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
      setRead({ kind: 'error', message: `${OFFLINE_MESSAGE} Fill in the details yourself, or try again online.` });
      return;
    }
    const token = guard.current.start();
    setRead({ kind: 'reading' });
    try {
      // Never waits forever (MA-11k): the whole reading (downsizing, upload, model) is bounded.
      const result = await withReceiptReadDeadline((async () => {
      const check = checkMaintenanceFile(entry.file);
      let payload: Blob = entry.file;
      let contentType = check.ok ? check.contentType : '';
      // A JPEG, PNG or WebP already small enough is sent as it is (no decode); a larger one is
      // shrunk; any other image (GIF, HEIC, AVIF) is always re-encoded to JPEG, which needs the
      // browser to decode it ("can't read" only when it cannot).
      const preparation = check.ok && check.image ? receiptImagePreparation(contentType, entry.file.size) : 'as_is';
      if (preparation !== 'as_is') {
        const smaller = await downscaleImage(entry.file, {
          maxEdge: RECEIPT_READ_MAX_EDGE, maxBytes: RECEIPT_READ_MAX_BYTES, force: preparation === 'convert',
        });
        if (!smaller.ok) {
          throw new Error(smaller.reason === 'too-large' ? 'too_large' : isHeicType(contentType) ? 'heic' : 'unreadable');
        }
        payload = smaller.file;
        contentType = smaller.file.type || 'image/jpeg';
      }
      if (!['image/jpeg', 'image/png', 'image/webp', 'application/pdf'].includes(contentType)) throw new Error('unreadable');
      if (payload.size > RECEIPT_READ_MAX_BYTES) throw new Error('too_large');
      const data = await toBase64(payload);
      return unwrapAiActionResult(await readMaintenanceReceipt(
        { fileName: entry.file.name.slice(0, 200) || 'receipt', contentType: contentType as 'image/jpeg', dataBase64: data },
        await getAiActionContext(householdId),
      ));
      })());
      if (!guard.current.isCurrent(token)) return;
      const fields = sanitizeReceiptFields(result);
      if (Object.keys(fields).length === 0) {
        setRead({ kind: 'error', message: "Couldn't find a cost, provider or parts on this receipt. Fill them in yourself; the receipt stays attached." });
        return;
      }
      setRead({ kind: 'result', fields, accepted: { cost: true, serviceProvider: true, partsUsed: true } });
    } catch (readError) {
      if (!guard.current.isCurrent(token)) return;
      const reason = readError instanceof Error ? readError.message : '';
      const message = reason === RECEIPT_READ_TIMEOUT
        ? "No answer from the receipt reader. Fill in the details yourself; the receipt stays attached."
        : reason === 'heic'
        ? "This browser can't read HEIC photos. Fill in the details yourself; the photo stays attached."
        : reason === 'unreadable'
          ? "This browser can't read this image format. Fill in the details yourself; it stays attached."
          : reason === 'too_large'
          ? 'This file is too large to read. Fill in the details yourself; it stays attached.'
          : readError instanceof AiClientError
            ? `${readError.message} The receipt stays attached.`
            : "Couldn't read the receipt. Fill in the details yourself; it stays attached.";
      setRead({ kind: 'error', message });
    }
  };

  const kept = read.kind === 'result' ? receiptFieldsKept(read.fields, editedFields()) : [];

  return (
    <div className="space-y-3 rounded-lg border p-3 sm:col-span-2" data-testid="receipt-picker">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="flex items-center gap-2 text-sm font-medium"><Paperclip aria-hidden className="h-4 w-4" />Receipt / photos</p>
        <div className="flex flex-wrap gap-2">
          {/* Phones open the camera; elsewhere it is an ordinary picker. */}
          <Button asChild type="button" variant="outline" size="sm" disabled={disabled}>
            <label className="relative cursor-pointer overflow-hidden">
              <Camera aria-hidden className="mr-2 h-4 w-4" />
              Take photo
              <input
                type="file"
                accept="image/*"
                capture="environment"
                className="sr-only"
                aria-label="Take a photo of the receipt"
                disabled={disabled}
                onChange={(event) => { add(event.target.files); event.target.value = ''; }}
              />
            </label>
          </Button>
          <Button asChild type="button" variant="outline" size="sm" disabled={disabled}>
            <label className="relative cursor-pointer overflow-hidden">
              <FileText aria-hidden className="mr-2 h-4 w-4" />
              Choose file
              <input
                type="file"
                accept={RECEIPT_ACCEPT}
                multiple
                className="sr-only"
                aria-label="Choose receipt or photo files"
                disabled={disabled}
                onChange={(event) => { add(event.target.files); event.target.value = ''; }}
              />
            </label>
          </Button>
        </div>
      </div>
      <FieldError id="receipt-picker-error">{error}</FieldError>
      {staged.length > 0 && (
        <ul className="grid gap-2 sm:grid-cols-2" aria-label="Files to attach">
          {staged.map(entry => {
            const preview = previews.get(entry.key);
            return (
              <li key={entry.key} className="flex items-center gap-3 rounded-md border p-2">
                <div className="flex h-12 w-12 shrink-0 items-center justify-center overflow-hidden rounded bg-muted">
                  {preview?.url
                    // eslint-disable-next-line @next/next/no-img-element
                    ? <img src={preview.url} alt="" className="h-full w-full object-cover" />
                    : preview?.heic
                      ? <ImageOff aria-hidden className="h-5 w-5 text-muted-foreground" />
                      : <FileText aria-hidden className="h-5 w-5 text-muted-foreground" />}
                </div>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm">{entry.file.name}</p>
                  <p className="text-xs text-muted-foreground">
                    {formatFileSize(entry.file.size)}{preview?.heic ? ' · HEIC preview not available' : ''}
                  </p>
                </div>
                <Button type="button" variant="ghost" size="icon" className="h-11 w-11" aria-label={`Remove ${entry.file.name}`} onClick={() => remove(entry.key)} disabled={disabled}>
                  <X aria-hidden className="h-4 w-4" />
                </Button>
              </li>
            );
          })}
        </ul>
      )}
      {staged.length > 0 && <p className="text-xs text-muted-foreground">Attached to the log when you save it.</p>}
      {readable && read.kind !== 'result' && (
        <div className="flex flex-wrap items-center gap-2">
          <Button type="button" variant="secondary" size="sm" onClick={() => void readReceipt()} disabled={disabled || read.kind === 'reading'}>
            {read.kind === 'reading' ? <Loader2 aria-hidden className="mr-2 h-4 w-4 animate-spin" /> : <Sparkles aria-hidden className="mr-2 h-4 w-4" />}
            {read.kind === 'reading' ? 'Reading receipt…' : 'Read receipt'}
          </Button>
          {read.kind === 'reading' && (
            <Button type="button" variant="ghost" size="sm" onClick={() => { guard.current.cancel(); setRead({ kind: 'idle' }); }}>Stop</Button>
          )}
        </div>
      )}
      <div role="status" aria-live="polite" className="text-sm">
        {read.kind === 'reading' && <span className="sr-only">Reading the receipt.</span>}
        {read.kind === 'error' && <p className="text-muted-foreground" data-testid="receipt-read-error">{read.message}</p>}
      </div>
      {read.kind === 'result' && (
        <div className="space-y-2 rounded-md border border-dashed p-3" data-testid="receipt-read-result">
          <p className="text-sm font-medium">From the receipt. Check them before using:</p>
          {(Object.keys(read.fields) as (keyof ReceiptFields)[]).map(field => (
            <div key={field} className="flex items-start gap-2">
              <Checkbox
                id={`receipt-${field}`}
                checked={read.accepted[field] && !kept.includes(field)}
                disabled={kept.includes(field)}
                onCheckedChange={(checked) => setRead({ ...read, accepted: { ...read.accepted, [field]: checked === true } })}
              />
              <Label htmlFor={`receipt-${field}`} className="font-normal">
                <span className="font-medium">{RECEIPT_FIELD_LABELS[field]}:</span>{' '}
                {field === 'cost' ? formatCurrency(read.fields.cost) : read.fields[field]}
                {kept.includes(field) && <span className="text-muted-foreground"> (you already entered one; yours stays)</span>}
              </Label>
            </div>
          ))}
          <div className="flex flex-wrap gap-2 pt-1">
            <Button type="button" size="sm" onClick={() => { onApply(read.fields, read.accepted); setRead({ kind: 'idle' }); }}>Use these</Button>
            <Button type="button" variant="ghost" size="sm" onClick={() => setRead({ kind: 'idle' })}>Dismiss</Button>
          </div>
        </div>
      )}
    </div>
  );
}
