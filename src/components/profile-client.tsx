'use client';

import { useEffect, useRef, useState } from 'react';
import { useForm, useWatch } from 'react-hook-form';
import { useUnsavedInput } from '@/hooks/use-shell-busy';
import { z } from 'zod';
import { zodResolver } from '@hookform/resolvers/zod';
import { Camera, Loader2, Trash2 } from 'lucide-react';
import { deleteObject, getStorage, ref, uploadBytes, getDownloadURL, type StorageReference } from 'firebase/storage';
import { useAuth } from '@/hooks/use-auth';
import { useToast } from '@/hooks/use-toast';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from '@/components/ui/form';
import { Input } from '@/components/ui/input';
import { FieldError } from '@/components/field-error';
import { MemberAvatar } from '@/components/member-avatar';
import { roleLabel } from '@/components/household/household-model';
import { AVATAR_MAX_BYTES } from '@/components/profile/profile-validation';
import { downscaleImage } from '@/lib/images/downscale';
import { AVATAR_MAX_EDGE, PROFILE_PHOTO_ACCEPT, avatarExtensionFor, ownAvatarPath, photoReplacedAndSafe, profilePhotoError } from '@/lib/profile/avatar';
import { NotificationSettings } from '@/components/profile/notification-settings';
import { AppearanceSettings } from './appearance-settings';
import { TabletPinCard } from '@/components/profile/tablet-pin-card';
import { BirthdayField, MemberColorPicker } from '@/components/profile/member-extras';
import { nicknameError } from '@/lib/profile/member-extras';
import { memberColorFor } from '@/lib/member-colors';
import { AccountCard } from '@/components/profile/account-card';

const profileSchema = z.object({
  displayName: z.string().trim().min(2, 'Use at least 2 characters.').max(60, 'Keep it under 60 characters.'),
  // PR-25: what the dashboard greeting calls you; one word, optional.
  nickname: z.string().superRefine((value, ctx) => {
    const error = nicknameError(value);
    if (error) ctx.addIssue({ code: z.ZodIssueCode.custom, message: error });
  }),
});

export function ProfileClient() {
  const { currentUser, currentMember, household, updateUser } = useAuth();
  const { toastError } = useToast();
  const [photoFile, setPhotoFile] = useState<File | null>(null);
  const [photoPreview, setPhotoPreview] = useState<string | null>(null);
  const [removePhoto, setRemovePhoto] = useState(false);
  const [photoError, setPhotoError] = useState<string | null>(null);
  const [preparingPhoto, setPreparingPhoto] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const form = useForm<z.infer<typeof profileSchema>>({
    resolver: zodResolver(profileSchema),
    defaultValues: {
      displayName: currentUser?.displayName || '',
      nickname: currentUser?.nickname || '',
    },
  });
  // An edited name, a chosen photo or a save in progress keeps the shell from reloading on its own.
  useUnsavedInput(form.formState.isDirty || Boolean(photoFile) || removePhoto || isSubmitting);
  // PR-15: leaving the page (reload, close, typed URL) with an unsaved name or photo asks first.
  const unsavedChanges = form.formState.isDirty || Boolean(photoFile) || removePhoto;
  useEffect(() => {
    if (!unsavedChanges) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [unsavedChanges]);

  // Object URLs for the local preview are released when replaced or unmounted.
  useEffect(() => () => {
    if (photoPreview) URL.revokeObjectURL(photoPreview);
  }, [photoPreview]);

  const uploadAvatar = async (file: File): Promise<{ url: string; storageRef: StorageReference }> => {
    if (!currentUser?.uid) throw new Error('User not authenticated');
    const storage = getStorage();
    // PR-9: the extension comes from the encoded type, never the picked file's name.
    const fileName = `${crypto.randomUUID()}.${avatarExtensionFor(file.type)}`;
    // Keyed by the account ID, so the photo's download URL carries no email.
    const storageRef = ref(storage, `users/${currentUser.uid}/avatars/${fileName}`);
    await uploadBytes(storageRef, file, { contentType: file.type });
    return { url: await getDownloadURL(storageRef), storageRef };
  };

  // PR-9: every photo is redrawn at 512 px before it is shown or uploaded, which also
  // drops EXIF metadata (GPS location included). HEIC works where the browser reads it.
  // The photo choice as of now (not as of the render that started a save), so a save
  // that finishes never clears a photo chosen after it began.
  const photoChoiceRef = useRef<File | null>(null);
  useEffect(() => { photoChoiceRef.current = photoFile; }, [photoFile]);

  const choosePhoto = async (file: File | undefined) => {
    if (!file) return;
    const error = profilePhotoError(file);
    setPhotoError(error);
    if (error) return;
    setPreparingPhoto(true);
    try {
      const result = await downscaleImage(file, { maxEdge: AVATAR_MAX_EDGE, maxBytes: AVATAR_MAX_BYTES, force: true });
      if (!result.ok) {
        setPhotoError(result.reason === 'unreadable'
          ? 'This photo could not be read on this device. Choose a JPG or PNG photo.'
          : 'This photo is too large even after shrinking it. Choose another one.');
        return;
      }
      setPhotoFile(result.file);
      setRemovePhoto(false);
      setPhotoPreview(URL.createObjectURL(result.file));
    } finally {
      setPreparingPhoto(false);
    }
  };

  // After a successful save, the replaced or removed photo is deleted when it is one of
  // this person's own uploads (never the Google account photo). Best effort.
  const deletePreviousPhoto = (previousUrl: string | null | undefined, keptUrl: string | null) => {
    if (!currentUser?.uid || !previousUrl || previousUrl === keptUrl) return;
    const storage = getStorage();
    const path = ownAvatarPath(previousUrl, { uid: currentUser.uid, email: currentUser.email }, storage.app.options.storageBucket);
    if (path) void deleteObject(ref(storage, path)).catch(() => undefined);
  };

  const clearPhotoChoice = () => {
    setPhotoFile(null);
    setPhotoPreview(null);
    setPhotoError(null);
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const onSubmit = async (values: z.infer<typeof profileSchema>) => {
    // A photo still being prepared is not saved half-way: Save waits for it (the button
    // is disabled meanwhile).
    if (!currentUser || preparingPhoto) return;
    const savedPhoto = photoFile;
    setIsSubmitting(true);
    try {
      const previousUrl = currentUser.avatarUrl;
      let avatarUrl = removePhoto ? null : currentUser.avatarUrl;
      let uploaded: StorageReference | null = null;
      if (savedPhoto) {
        const upload = await uploadAvatar(savedPhoto);
        avatarUrl = upload.url;
        uploaded = upload.storageRef;
      }

      const newUrl = avatarUrl || null;
      const saved = await updateUser({
        displayName: values.displayName.trim(),
        nickname: values.nickname.trim() || null,
        avatarUrl: newUrl,
      }, {
        // The old photo is deleted only once nothing housemates read can still point at
        // it: no household, or the membership record confirmed with the new photo.
        // Otherwise it is kept (an orphaned file, never a broken avatar).
        onMemberSync: (sync) => {
          if (photoReplacedAndSafe(sync, newUrl)) deletePreviousPhoto(previousUrl, newUrl);
        },
      });
      // PR-1: a failed save keeps the chosen photo and the edited name on screen (the
      // error toast has been shown) and removes the file it uploaded, which nothing uses.
      if (!saved) {
        if (uploaded) void deleteObject(uploaded).catch(() => undefined);
        return;
      }

      // Only the photo this save uploaded is cleared; one chosen meanwhile stays pending.
      if (photoChoiceRef.current === savedPhoto) {
        clearPhotoChoice();
        setRemovePhoto(false);
      }
      form.reset({ displayName: values.displayName.trim(), nickname: values.nickname.trim() });
    } catch (error) {
      console.error('Failed to update profile', error);
      toastError(error, 'Could not save your profile');
    } finally {
      setIsSubmitting(false);
    }
  };

  const watchedName = useWatch({ control: form.control, name: 'displayName' });
  if (!currentUser) return null;

  const shownName = watchedName?.trim() || currentUser.displayName || currentUser.email;
  const shownPhoto = photoPreview ?? (removePhoto ? null : currentUser.avatarUrl);
  const hasPhoto = Boolean(shownPhoto);
  const photoChanged = Boolean(photoFile) || removePhoto;

  return (
    // PR-18: two equal columns only when both fit at their rem-based minimum width
    // (24rem each): px breakpoints ignore the text size, so 130% text, or a 768-800 px
    // tablet, stacks them instead of squeezing one column. Personal information and
    // notifications on the left, appearance beside them.
    <div className="mx-auto flex max-w-6xl flex-wrap gap-8">
      <div className="min-w-0 flex-[1_1_24rem] space-y-8">
        <Card>
          <CardHeader>
            <CardTitle as="h2" className="font-headline">Personal Information</CardTitle>
            <CardDescription>How you appear to the rest of your household.</CardDescription>
          </CardHeader>
          <CardContent>
            <Form {...form}>
              <form onSubmit={(event) => void form.handleSubmit(onSubmit)(event)} className="space-y-6" noValidate>
                <div className="flex flex-col gap-4 sm:flex-row sm:items-center">
                  {/* The current avatar: the photo, or the generated gradient in the member color. */}
                  <MemberAvatar
                    uid={currentUser.uid || currentUser.email}
                    name={shownName}
                    photoUrl={shownPhoto}
                    color={memberColorFor(currentUser.uid || currentUser.email, currentMember?.color)}
                    size="lg"
                    ring
                    className="h-20 w-20 text-2xl"
                  />
                  <div className="min-w-0 flex-1 space-y-2">
                    <div>
                      <p className="break-words font-semibold">{shownName}</p>
                      {household && currentMember && (
                        <p className="break-words text-sm text-muted-foreground">
                          {roleLabel(currentMember.role)}{household.name ? ` · ${household.name}` : ''}
                        </p>
                      )}
                    </div>
                    <div className="flex flex-wrap gap-2">
                      <input
                        ref={fileInputRef}
                        id="profile-photo"
                        type="file"
                        accept={PROFILE_PHOTO_ACCEPT}
                        className="sr-only"
                        tabIndex={-1}
                        aria-label="Profile photo"
                        onChange={(event) => void choosePhoto(event.target.files?.[0])}
                        disabled={isSubmitting || preparingPhoto}
                      />
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        disabled={isSubmitting || preparingPhoto}
                        aria-describedby={photoError ? 'profile-photo-error' : 'profile-photo-hint'}
                        aria-invalid={photoError ? true : undefined}
                        onClick={() => fileInputRef.current?.click()}
                      >
                        {preparingPhoto ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Camera className="mr-2 h-4 w-4" />}
                        {hasPhoto ? 'Change photo' : 'Add photo'}
                      </Button>
                      {photoFile ? (
                        <Button type="button" variant="ghost" size="sm" disabled={isSubmitting} onClick={clearPhotoChoice}>
                          Undo
                        </Button>
                      ) : currentUser.avatarUrl && !removePhoto ? (
                        <Button type="button" variant="ghost" size="sm" disabled={isSubmitting} onClick={() => setRemovePhoto(true)}>
                          <Trash2 className="mr-2 h-4 w-4" />
                          Remove photo
                        </Button>
                      ) : removePhoto ? (
                        <Button type="button" variant="ghost" size="sm" disabled={isSubmitting} onClick={() => setRemovePhoto(false)}>
                          Keep photo
                        </Button>
                      ) : null}
                    </div>
                    <FieldError id="profile-photo">{photoError}</FieldError>
                    <p id="profile-photo-hint" className="text-xs text-muted-foreground">
                      {photoChanged
                        ? 'Save changes to update your photo.'
                        : 'JPG, PNG, GIF, WebP or HEIC. Photos are shrunk to 512 px and their location data is removed. Without a photo you get a gradient in your colour, which you can choose below.'}
                    </p>
                  </div>
                </div>
                <FormField
                  control={form.control}
                  name="displayName"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Display Name</FormLabel>
                      <FormControl>
                        <Input placeholder="Your name" autoComplete="name" maxLength={60} {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                <FormField
                  control={form.control}
                  name="nickname"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>What should we call you? <span className="font-normal text-muted-foreground">(optional)</span></FormLabel>
                      <FormControl>
                        <Input placeholder="For example Mom or Grandpa" autoComplete="nickname" maxLength={20} {...field} />
                      </FormControl>
                      <p className="text-xs text-muted-foreground">Used in your dashboard greeting. Only you see it.</p>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                {/* PR-15: enabled only when something changed. */}
                <Button type="submit" disabled={isSubmitting || preparingPhoto || !(form.formState.isDirty || photoChanged)}>
                  {isSubmitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                  Save Changes
                </Button>
              </form>
            </Form>
            {household && currentMember?.status === 'active' && (
              <div className="mt-6 space-y-6 border-t pt-6">
                <MemberColorPicker />
                <BirthdayField />
              </div>
            )}
          </CardContent>
        </Card>
        <NotificationSettings />
        <AccountCard />
      </div>
      <div className="min-w-0 flex-[1_1_24rem] space-y-8">
        <AppearanceSettings />
        <TabletPinCard />
      </div>
    </div>
  );
}
