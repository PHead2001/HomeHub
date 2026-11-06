

'use client';

import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { zodResolver } from '@hookform/resolvers/zod';
import { useAuth } from '@/hooks/use-auth';
import { useToast } from '@/hooks/use-toast';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from '@/components/ui/form';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ImageUpload } from './image-upload';
import { Loader2, BellRing } from 'lucide-react';
import { getStorage, ref, uploadBytes, getDownloadURL } from 'firebase/storage';
import { v4 as uuidv4 } from 'uuid';
import { cn } from '@/lib/utils';
import { Switch } from './ui/switch';
import { PushNotificationSettings } from './PushNotificationSettings';
import { AppearanceSettings } from './appearance-settings';

const profileSchema = z.object({
  displayName: z.string().min(2, 'Display name must be at least 2 characters.'),
});

function ChoreReminderSettings() {
    const { currentUser, updateUser } = useAuth();
    const { toast } = useToast();
    const [isSaving, setIsSaving] = useState(false);

    const [enabled, setEnabled] = useState(currentUser?.choreSettings?.reminderEnabled || false);
    const [time, setTime] = useState(currentUser?.choreSettings?.reminderTime || '17:00');

    const handleSave = async () => {
        setIsSaving(true);
        const choreSettings = {
            reminderEnabled: enabled,
            reminderTime: time,
        };
        await updateUser({ choreSettings });
        setIsSaving(false);
        toast({ title: "Reminder settings saved!" });
    };

    return (
        <Card>
            <CardHeader>
                <CardTitle className="font-headline flex items-center gap-2"><BellRing/> Chore Reminders</CardTitle>
                <CardDescription>Set a daily time to be automatically reminded of your incomplete chores.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
                <div className="flex items-center justify-between rounded-lg border p-4">
                    <div className="space-y-0.5">
                        <Label htmlFor="reminder-enabled" className="text-base">
                            Enable automatic reminders
                        </Label>
                    </div>
                    <Switch id="reminder-enabled" checked={enabled} onCheckedChange={setEnabled} />
                </div>
                 <div className={cn('space-y-2', !enabled && 'opacity-50 pointer-events-none')}>
                    <Label htmlFor="reminder-time">Remind me at</Label>
                    <Input
                        id="reminder-time"
                        type="time"
                        value={time}
                        onChange={(e) => setTime(e.target.value)}
                        className="w-48"
                    />
                </div>
                <Button onClick={handleSave} disabled={isSaving} className="w-full">
                    {isSaving && <Loader2 className="mr-2 animate-spin" />}
                    Save Reminder Settings
                </Button>
            </CardContent>
        </Card>
    )
}

export function ProfileClient() {
  const { currentUser, updateUser } = useAuth();
  const { toast } = useToast();
  const [photoFile, setPhotoFile] = useState<File | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const form = useForm<z.infer<typeof profileSchema>>({
    resolver: zodResolver(profileSchema),
    defaultValues: {
      displayName: currentUser?.displayName || '',
    },
  });

  const uploadAvatar = async (file: File): Promise<string> => {
    if (!currentUser?.email) throw new Error("User not authenticated");
    const storage = getStorage();
    const fileExtension = file.name.split('.').pop();
    const fileName = `${uuidv4()}.${fileExtension}`;
    const storageRef = ref(storage, `users/${currentUser.email}/avatars/${fileName}`);
    await uploadBytes(storageRef, file);
    return getDownloadURL(storageRef);
  };

  const onSubmit = async (values: z.infer<typeof profileSchema>) => {
    if (!currentUser) return;
    setIsSubmitting(true);
    try {
      let avatarUrl = currentUser.avatarUrl;
      if (photoFile) {
        avatarUrl = await uploadAvatar(photoFile);
      }
      
      await updateUser({
        displayName: values.displayName,
        avatarUrl: avatarUrl || null,
      });

      setPhotoFile(null); // Reset file input after successful upload
    } catch (error) {
      console.error("Failed to update profile", error);
      toast({ variant: 'destructive', title: 'Update Failed', description: 'Could not update your profile.' });
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="grid grid-cols-1 md:grid-cols-3 gap-8 max-w-6xl mx-auto">
        <div className="md:col-span-2 space-y-8">
            <Card>
                <CardHeader>
                    <CardTitle className="font-headline">Personal Information</CardTitle>
                    <CardDescription>Update your display name and profile picture.</CardDescription>
                </CardHeader>
                <CardContent>
                    <Form {...form}>
                    <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-6">
                        <div className="grid grid-cols-4 items-center gap-4">
                            <Label className="text-right">
                                Profile Picture
                            </Label>
                            <div className="col-span-3">
                                <ImageUpload 
                                    onFileChange={setPhotoFile} 
                                    existingImageUrl={currentUser?.avatarUrl ?? undefined} 
                                />
                            </div>
                        </div>
                        <FormField
                        control={form.control}
                        name="displayName"
                        render={({ field }) => (
                            <FormItem>
                            <FormLabel>Display Name</FormLabel>
                            <FormControl>
                                <Input placeholder="Your Name" {...field} />
                            </FormControl>
                            <FormMessage />
                            </FormItem>
                        )}
                        />
                        <FormItem>
                            <FormLabel>Email</FormLabel>
                            <FormControl>
                                <Input disabled value={currentUser?.email || ''} />
                            </FormControl>
                        </FormItem>

                        <Button type="submit" disabled={isSubmitting}>
                        {isSubmitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                        Save Changes
                        </Button>
                    </form>
                    </Form>
                </CardContent>
            </Card>
        </div>
        <div className="md:col-span-1 space-y-8">
            <AppearanceSettings />
            <ChoreReminderSettings />
            <PushNotificationSettings />
        </div>
    </div>
  );
}
