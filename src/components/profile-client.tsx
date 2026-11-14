'use client';

import { useEffect, useRef, useState } from 'react';
import { useForm, useWatch } from 'react-hook-form';
import { useUnsavedInput } from '@/hooks/use-shell-busy';
import { z } from 'zod';
import { zodResolver } from '@hookform/resolvers/zod';
import { BellRing, Camera, Loader2, Trash2 } from 'lucide-react';
import { getStorage, ref, uploadBytes, getDownloadURL } from 'firebase/storage';
import { useAuth } from '@/hooks/use-auth';
import { useToast } from '@/hooks/use-toast';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from '@/components/ui/form';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { FieldError } from '@/components/field-error';
import { MemberAvatar } from '@/components/member-avatar';
import { cn } from '@/lib/utils';
import { roleLabel } from '@/components/household/household-model';
import { AVATAR_ACCEPT, avatarFileError } from '@/components/profile/profile-validation';
import { PushNotificationSettings } from './PushNotificationSettings';
import { AppearanceSettings } from './appearance-settings';
import { TabletPinCard } from '@/components/profile/tablet-pin-card';

const profileSchema = z.object({
  displayName: z.string().trim().min(2, 'Use at least 2 characters.').max(60, 'Keep it under 60 characters.'),
});

function ChoreReminderSettings() {
  const { currentUser, updateUser } = useAuth();
  const { toast } = useToast();
  const [isSaving, setIsSaving] = useState(false);

  const [enabled, setEnabled] = useState(currentUser?.choreSettings?.reminderEnabled || false);
  const [time, setTime] = useState(currentUser?.choreSettings?.reminderTime || '17:00');

  const handleSave = async () => {
    setIsSaving(true);
    try {
      // Silent: one outcome toast here instead of the generic "Profile Updated".
      // A failed write still shows updateUser's error toast.
      await updateUser({ choreSettings: { reminderEnabled: enabled, reminderTime: time } }, undefined, { silent: true });
      toast({ title: 'Reminder saved', description: enabled ? `We'll remind you at ${time} each day.` : 'Daily chore reminders are off.' });
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="font-headline flex items-center gap-2"><BellRing aria-hidden /> Chore Reminders</CardTitle>
        <CardDescription>A daily nudge about chores you haven&apos;t finished yet.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex items-center justify-between gap-3 rounded-lg border p-4">
          <Label htmlFor="reminder-enabled" className="text-base">
            Remind me every day
          </Label>
          <Switch id="reminder-enabled" checked={enabled} onCheckedChange={setEnabled} />
        </div>
        <div className={cn('space-y-2', !enabled && 'opacity-50')}>
          <Label htmlFor="reminder-time">Remind me at</Label>
          <Input
            id="reminder-time"
            type="time"
            value={time}
            disabled={!enabled}
            onChange={(e) => setTime(e.target.value)}
            className="w-48"
          />
        </div>
        <Button onClick={handleSave} disabled={isSaving} className="w-full">
          {isSaving && <Loader2 className="mr-2 animate-spin" />}
          Save reminder
        </Button>
      </CardContent>
    </Card>
  );
}

export function ProfileClient() {
  const { currentUser, currentMember, household, updateUser } = useAuth();
  const { toastError } = useToast();
  const [photoFile, setPhotoFile] = useState<File | null>(null);
  const [photoPreview, setPhotoPreview] = useState<string | null>(null);
  const [removePhoto, setRemovePhoto] = useState(false);
  const [photoError, setPhotoError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const form = useForm<z.infer<typeof profileSchema>>({
    resolver: zodResolver(profileSchema),
    defaultValues: {
      displayName: currentUser?.displayName || '',
    },
  });
  // An edited name, a chosen photo or a save in progress keeps the shell from reloading on its own.
  useUnsavedInput(form.formState.isDirty || Boolean(photoFile) || removePhoto || isSubmitting);

  // Object URLs for the local preview are released when replaced or unmounted.
  useEffect(() => () => {
    if (photoPreview) URL.revokeObjectURL(photoPreview);
  }, [photoPreview]);

  const uploadAvatar = async (file: File): Promise<string> => {
    if (!currentUser?.uid) throw new Error('User not authenticated');
    const storage = getStorage();
    const fileExtension = file.name.split('.').pop();
    const fileName = `${crypto.randomUUID()}.${fileExtension}`;
    // Keyed by the account ID, so the photo's download URL carries no email.
    const storageRef = ref(storage, `users/${currentUser.uid}/avatars/${fileName}`);
    await uploadBytes(storageRef, file);
    return getDownloadURL(storageRef);
  };

  const choosePhoto = (file: File | undefined) => {
    if (!file) return;
    const error = avatarFileError(file);
    setPhotoError(error);
    if (error) return;
    setPhotoFile(file);
    setRemovePhoto(false);
    setPhotoPreview(URL.createObjectURL(file));
  };

  const clearPhotoChoice = () => {
    setPhotoFile(null);
    setPhotoPreview(null);
    setPhotoError(null);
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const onSubmit = async (values: z.infer<typeof profileSchema>) => {
    if (!currentUser) return;
    setIsSubmitting(true);
    try {
      let avatarUrl = removePhoto ? null : currentUser.avatarUrl;
      if (photoFile) {
        avatarUrl = await uploadAvatar(photoFile);
      }

      await updateUser({
        displayName: values.displayName.trim(),
        avatarUrl: avatarUrl || null,
      });

      clearPhotoChoice();
      setRemovePhoto(false);
      form.reset({ displayName: values.displayName.trim() });
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
    // Two columns only when both fit at their rem-based minimum widths (32rem and
    // 20rem): px breakpoints ignore the text size, so 130% text at 768-1023 px stacks.
    <div className="mx-auto flex max-w-6xl flex-wrap gap-8">
      <div className="min-w-0 flex-[2_1_32rem] space-y-8">
        <Card>
          <CardHeader>
            <CardTitle className="font-headline">Personal Information</CardTitle>
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
                        accept={AVATAR_ACCEPT}
                        className="sr-only"
                        tabIndex={-1}
                        aria-label="Profile photo"
                        onChange={(event) => choosePhoto(event.target.files?.[0])}
                        disabled={isSubmitting}
                      />
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        disabled={isSubmitting}
                        aria-describedby={photoError ? 'profile-photo-error' : 'profile-photo-hint'}
                        aria-invalid={photoError ? true : undefined}
                        onClick={() => fileInputRef.current?.click()}
                      >
                        <Camera className="mr-2 h-4 w-4" />
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
                        : 'JPG, PNG, GIF or WebP, up to 5 MB. Without a photo you get a gradient in your member color.'}
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
                <div className="space-y-2">
                  <Label htmlFor="profile-email">Email</Label>
                  <Input id="profile-email" disabled value={currentUser.email || ''} />
                </div>

                <Button type="submit" disabled={isSubmitting}>
                  {isSubmitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                  Save Changes
                </Button>
              </form>
            </Form>
          </CardContent>
        </Card>
      </div>
      <div className="min-w-0 flex-[1_1_20rem] space-y-8">
        <AppearanceSettings />
        <ChoreReminderSettings />
        <PushNotificationSettings />
        <TabletPinCard />
      </div>
    </div>
  );
}
