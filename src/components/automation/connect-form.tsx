'use client';

import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Loader2, Plug } from 'lucide-react';
import { auth } from '@/lib/firebase';
import { useAuth } from '@/hooks/use-auth';
import { saveHomeAssistantConnection } from '@/app/automation/actions';
import { Button } from '@/components/ui/button';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';
import { Form, FormControl, FormDescription, FormField, FormItem, FormLabel, FormMessage } from '@/components/ui/form';
import { Input } from '@/components/ui/input';
import { friendlyError } from '@/lib/friendly-error';

const credentialsSchema = z.object({
  url: z.string().trim().url('Enter the full address, starting with https://'),
  accessToken: z.string().trim().min(20, 'Paste the full long-lived access token.'),
});
type Credentials = z.infer<typeof credentialsSchema>;

export function ConnectForm({ onSaved }: { onSaved: (host: string, count: number) => void }) {
  const { currentUser } = useAuth();
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const form = useForm<Credentials>({ resolver: zodResolver(credentialsSchema), defaultValues: { url: '', accessToken: '' } });

  const onSubmit = async (values: Credentials) => {
    const firebaseUser = auth.currentUser;
    if (!firebaseUser || !currentUser?.householdId) return;
    setIsSubmitting(true);
    setError(null);
    try {
      const result = await saveHomeAssistantConnection(
        { idToken: await firebaseUser.getIdToken(), householdId: currentUser.householdId },
        values
      );
      // Entered values stay in the form when something goes wrong.
      if (!result.ok) setError(result.message);
      else onSaved(result.data.host, result.data.entityCount);
    } catch (caught) {
      setError(friendlyError(caught));
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <Card className="w-full max-w-lg">
      <Form {...form}>
        <form onSubmit={form.handleSubmit(onSubmit)} noValidate>
          <CardHeader>
            <CardTitle className="font-headline flex items-center gap-2"><Plug className="h-5 w-5" /> Connect Home Assistant</CardTitle>
            <CardDescription>
              See the state of your lights, sensors and devices in HomeHub. HomeHub only reads states; it never controls devices.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {error && (
              <Alert variant="destructive" role="alert">
                <AlertTitle>Could not connect</AlertTitle>
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            )}
            <FormField
              control={form.control}
              name="url"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Home Assistant address</FormLabel>
                  <FormControl>
                    <Input placeholder="https://your-home.ui.nabu.casa" inputMode="url" autoComplete="off" {...field} />
                  </FormControl>
                  <FormDescription>Must be an https address that works away from home, such as Nabu Casa.</FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="accessToken"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Long-lived access token</FormLabel>
                  <FormControl>
                    <Input type="password" placeholder="Paste your token" autoComplete="off" {...field} />
                  </FormControl>
                  <FormDescription>In Home Assistant, open your profile, then Security, then Create token.</FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />
          </CardContent>
          <CardFooter>
            <Button type="submit" disabled={isSubmitting} className="w-full sm:w-auto">
              {isSubmitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {isSubmitting ? 'Checking connection…' : 'Test and connect'}
            </Button>
          </CardFooter>
        </form>
      </Form>
    </Card>
  );
}
