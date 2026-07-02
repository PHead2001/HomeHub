

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
import { Loader2, Palette, RotateCcw, BellRing } from 'lucide-react';
import { getStorage, ref, uploadBytes, getDownloadURL } from 'firebase/storage';
import { v4 as uuidv4 } from 'uuid';
import { HouseholdInfo } from './household-manager';
import { cn } from '@/lib/utils';
import { Switch } from './ui/switch';
import { PushNotificationSettings } from './PushNotificationSettings';

const profileSchema = z.object({
  displayName: z.string().min(2, 'Display name must be at least 2 characters.'),
});

// Helper to convert hex to HSL string
const hexToHslString = (hex: string): string | null => {
    if (!hex) return null;
    let r = 0, g = 0, b = 0;
    if (hex.length == 4) {
        r = parseInt(hex[1] + hex[1], 16);
        g = parseInt(hex[2] + hex[2], 16);
        b = parseInt(hex[3] + hex[3], 16);
    } else if (hex.length == 7) {
        r = parseInt(hex[1] + hex[2], 16);
        g = parseInt(hex[3] + hex[4], 16);
        b = parseInt(hex[5] + hex[6], 16);
    } else {
        return null; // Invalid hex
    }

    r /= 255;
    g /= 255;
    b /= 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    let h = 0, s = 0, l = (max + min) / 2;

    if (max !== min) {
        const d = max - min;
        s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
        switch (max) {
            case r: h = (g - b) / d + (g < b ? 6 : 0); break;
            case g: h = (b - r) / d + 2; break;
            case b: h = (r - g) / d + 4; break;
        }
        h /= 6;
    }
    
    h = Math.round(h * 360);
    s = Math.round(s * 100);
    l = Math.round(l * 100);
    
    return `${h} ${s}% ${l}%`;
}


function ThemeCustomizer() {
    const { currentUser, updateUser } = useAuth();
    const { toast } = useToast();

    const defaultBackgroundHex = '#020817';
    const defaultAccentHex = '#4DB6AC';
    
    const [background, setBackground] = useState(currentUser?.theme?.backgroundHex || defaultBackgroundHex);
    const [accent, setAccent] = useState(currentUser?.theme?.accentHex || defaultAccentHex);

    const isDefaultTheme =
      (!currentUser?.theme) ||
      (currentUser.theme.backgroundHex === defaultBackgroundHex &&
       currentUser.theme.accentHex === defaultAccentHex);

    const handleSaveTheme = async () => {
        const theme = {
            background: hexToHslString(background) ?? undefined,
            accent: hexToHslString(accent) ?? undefined,
            backgroundHex: background,
            accentHex: accent
        }
        await updateUser({ theme });
        toast({ title: "Theme Saved!", description: "Your new colors have been applied." });
    }

    const handleResetTheme = async () => {
        setBackground(defaultBackgroundHex);
        setAccent(defaultAccentHex);
        await updateUser({ theme: null });
        toast({ title: "Theme Reset!", description: "Your theme has been reset to the default." });
    }

    return (
        <Card>
            <CardHeader>
                <CardTitle className="font-headline flex items-center gap-2"><Palette/> Theme</CardTitle>
                <CardDescription>Customize the look of your app.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
                 <div className="flex items-center justify-between">
                    <Label htmlFor="background-color">Background</Label>
                    <div className="relative h-8 w-16 rounded-md border border-input">
                        <Input 
                            id="background-color" 
                            type="color" 
                            value={background} 
                            onChange={(e) => setBackground(e.target.value)} 
                            className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
                        />
                        <div className="h-full w-full rounded-md" style={{ backgroundColor: background }} />
                    </div>
                </div>
                 <div className="flex items-center justify-between">
                    <Label htmlFor="accent-color">Accent</Label>
                    <div className="relative h-8 w-16 rounded-md border border-input">
                         <Input 
                            id="accent-color" 
                            type="color" 
                            value={accent} 
                            onChange={(e) => setAccent(e.target.value)}
                            className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
                         />
                         <div className="h-full w-full rounded-md" style={{ backgroundColor: accent }} />
                    </div>
                </div>
                <div className="flex items-center gap-2">
                    <Button onClick={handleSaveTheme} className="flex-1">Save Theme</Button>
                    {!isDefaultTheme && (
                         <Button onClick={handleResetTheme} variant="ghost" className="text-muted-foreground">
                            <RotateCcw className="mr-2" /> Reset
                        </Button>
                    )}
                </div>
            </CardContent>
        </Card>
    )
}

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
            <HouseholdInfo />
            <ThemeCustomizer />
            <ChoreReminderSettings />
            <PushNotificationSettings />
        </div>
    </div>
  );
}
