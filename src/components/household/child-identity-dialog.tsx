'use client';

import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { Camera, Loader2 } from 'lucide-react';
import { getDownloadURL, getStorage, ref, uploadBytes } from 'firebase/storage';
import { useUnsavedInput } from '@/hooks/use-shell-busy';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { FieldError, fieldErrorProps } from '@/components/field-error';
import { MemberAvatar } from '@/components/member-avatar';
import { AVATAR_ACCEPT, avatarFileError } from '@/components/profile/profile-validation';
import { CHILD_NAME_MAX, kidAvatarPath, readChildName } from '@/lib/devices/child-identities';
import { validatePinFormat } from '@/lib/devices/pins';
import type { HouseholdMember } from '@/lib/types';

// Kid profiles from the Members tab (docs/modules/devices/README.md, "Actors"): create
// or edit one (name, optional photo) and set its tablet PIN. Owners and admins only;
// the server checks the role on every call. Kid profiles have no sign-in and no email.

export type KidProfileSave = (input: { name: string; photo: File | null; removePhoto: boolean }) => Promise<boolean>;

/** Uploads a kid profile photo to its Storage folder and returns the download URL. */
export const uploadKidPhoto = async (householdId: string, childId: string, file: File): Promise<string> => {
  const extension = (file.name.split('.').pop() || 'jpg').replace(/[^a-z0-9]/gi, '').slice(0, 5) || 'jpg';
  const storageRef = ref(getStorage(), kidAvatarPath(householdId, childId, `${crypto.randomUUID()}.${extension}`));
  await uploadBytes(storageRef, file, { contentType: file.type });
  return getDownloadURL(storageRef);
};

export function KidProfileDialog({
  open,
  onOpenChange,
  child,
  onSave,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Editing this kid profile; absent: creating one. */
  child: HouseholdMember | null;
  onSave: KidProfileSave;
}) {
  const formId = useId();
  const fileInput = useRef<HTMLInputElement>(null);
  // The parent mounts a fresh dialog (new key) each time it opens, so state starts clean.
  const [name, setName] = useState(child?.displayName ?? '');
  const [photo, setPhoto] = useState<File | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [removePhoto, setRemovePhoto] = useState(false);
  const [photoError, setPhotoError] = useState<string | null>(null);
  const [submitted, setSubmitted] = useState(false);
  const [saving, setSaving] = useState(false);
  useEffect(() => () => {
    if (preview) URL.revokeObjectURL(preview);
  }, [preview]);
  useUnsavedInput(open && (saving || Boolean(photo) || name !== (child?.displayName ?? '')));

  const nameError = submitted && !readChildName(name) ? `Enter a name (1 to ${CHILD_NAME_MAX} characters, not an email address).` : null;
  const shownPhoto = preview ?? (removePhoto ? null : child?.avatarUrl ?? null);

  const choose = (file: File | undefined) => {
    if (!file) return;
    const error = avatarFileError(file);
    setPhotoError(error);
    if (error) return;
    setPhoto(file);
    setRemovePhoto(false);
    setPreview(URL.createObjectURL(file));
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setSubmitted(true);
    const clean = readChildName(name);
    if (!clean) return;
    setSaving(true);
    try {
      if (await onSave({ name: clean, photo, removePhoto })) onOpenChange(false);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!saving) onOpenChange(next); }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{child ? 'Edit kid profile' : 'Add a kid profile'}</DialogTitle>
          <DialogDescription>
            For a child without their own account. They appear on wall tablets in &quot;Who&apos;s here?&quot; and can be credited with chores and pet care. They never sign in.
          </DialogDescription>
        </DialogHeader>
        <form id={formId} noValidate onSubmit={(event) => void submit(event)} className="space-y-4">
          <div className="flex items-center gap-3">
            <MemberAvatar uid={child?.uid ?? 'new-kid'} name={readChildName(name) ?? 'Kid'} photoUrl={shownPhoto} size="lg" decorative />
            <div className="flex flex-wrap gap-2">
              <input
                ref={fileInput}
                type="file"
                accept={AVATAR_ACCEPT}
                className="sr-only"
                tabIndex={-1}
                aria-label="Kid profile photo"
                onChange={(event) => choose(event.target.files?.[0])}
              />
              <Button type="button" variant="outline" size="sm" onClick={() => fileInput.current?.click()} disabled={saving}
                aria-describedby={photoError ? `${formId}-photo-error` : undefined}>
                <Camera className="mr-2 h-4 w-4" aria-hidden />
                {shownPhoto ? 'Change photo' : 'Add photo'}
              </Button>
              {child?.avatarUrl && !photo && !removePhoto && (
                <Button type="button" variant="ghost" size="sm" onClick={() => setRemovePhoto(true)} disabled={saving}>Remove photo</Button>
              )}
            </div>
          </div>
          <FieldError id={`${formId}-photo`}>{photoError}</FieldError>
          <div className="grid gap-1.5">
            <Label htmlFor={`${formId}-name`}>Name</Label>
            <Input
              {...fieldErrorProps(`${formId}-name`, nameError)}
              value={name}
              maxLength={CHILD_NAME_MAX}
              autoComplete="off"
              onChange={(event) => setName(event.target.value)}
            />
            <FieldError id={`${formId}-name`}>{nameError}</FieldError>
          </div>
        </form>
        <DialogFooter>
          <Button type="button" variant="ghost" onClick={() => onOpenChange(false)} disabled={saving}>Cancel</Button>
          <Button type="submit" form={formId} disabled={saving}>
            {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            {child ? 'Save' : 'Add kid profile'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Set or change a kid profile's tablet PIN (owner/admin, from their own device). */
export function KidPinDialog({
  open,
  onOpenChange,
  child,
  onSave,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  child: HouseholdMember | null;
  onSave: (pin: string) => Promise<boolean>;
}) {
  const formId = useId();
  const [pin, setPin] = useState('');
  const [confirm, setConfirm] = useState('');
  const [submitted, setSubmitted] = useState(false);
  const [saving, setSaving] = useState(false);
  useUnsavedInput(open && (saving || pin.length > 0));

  const format = validatePinFormat(pin);
  const pinError = submitted && !format.ok ? format.message : null;
  const confirmError = submitted && format.ok && confirm !== pin ? "The two PINs don't match." : null;
  const name = child?.displayName?.trim() || 'this kid';

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setSubmitted(true);
    if (!format.ok || confirm !== pin) return;
    setSaving(true);
    try {
      if (await onSave(pin)) onOpenChange(false);
    } finally {
      setSaving(false);
    }
  };

  const digits = (value: string) => value.replace(/\D/g, '').slice(0, 6);

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!saving) onOpenChange(next); }}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>Tablet PIN for {name}</DialogTitle>
          <DialogDescription>
            {name} types this on a wall tablet when a PIN is needed. Tell them in person; it is never shown again.
          </DialogDescription>
        </DialogHeader>
        <form id={formId} noValidate onSubmit={(event) => void submit(event)} className="space-y-3">
          <div className="grid gap-1.5">
            <Label htmlFor={`${formId}-pin`}>PIN (4 to 6 digits)</Label>
            <Input {...fieldErrorProps(`${formId}-pin`, pinError)} type="password" inputMode="numeric" autoComplete="off" maxLength={6}
              value={pin} onChange={(event) => setPin(digits(event.target.value))} />
            <FieldError id={`${formId}-pin`}>{pinError}</FieldError>
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor={`${formId}-confirm`}>Type it again</Label>
            <Input {...fieldErrorProps(`${formId}-confirm`, confirmError)} type="password" inputMode="numeric" autoComplete="off" maxLength={6}
              value={confirm} onChange={(event) => setConfirm(digits(event.target.value))} />
            <FieldError id={`${formId}-confirm`}>{confirmError}</FieldError>
          </div>
        </form>
        <DialogFooter>
          <Button type="button" variant="ghost" onClick={() => onOpenChange(false)} disabled={saving}>Cancel</Button>
          <Button type="submit" form={formId} disabled={saving}>
            {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Save PIN
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
