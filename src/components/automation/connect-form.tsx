'use client';

import { useEffect, useRef, useState } from 'react';
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

/**
 * AU-7: connecting, with a short step-by-step guide, a "Why https?" note, and focus moved
 * to the error after a failed test (so screen readers and keyboards land on it).
 */
export function ConnectForm({ onSaved }: { onSaved: (host: string, count: number) => void }) {
  const { currentUser } = useAuth();
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const errorRef = useRef<HTMLDivElement>(null);
  const form = useForm<Credentials>({ resolver: zodResolver(credentialsSchema), defaultValues: { url: '', accessToken: '' } });

  useEffect(() => {
    if (error) errorRef.current?.focus();
  }, [error, attempt]);

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
      setAttempt((value) => value + 1);
      setIsSubmitting(false);
    }
  };

  return (
    <Card className="w-full max-w-lg">
      <Form {...form}>
        <form onSubmit={form.handleSubmit(onSubmit)} noValidate>
          <CardHeader>
            <CardTitle className="font-headline flex items-center gap-2"><Plug className="h-5 w-5" /> Connect Home Assistant</CardTitle>
            <CardDescription>Two things from Home Assistant: its outside address and a token.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {error && (
              <Alert variant="destructive" role="alert" ref={errorRef} tabIndex={-1} className="outline-none focus-visible:ring-2 focus-visible:ring-ring">
                <AlertTitle>Could not connect</AlertTitle>
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            )}
            <ol className="list-decimal space-y-1 pl-5 text-sm text-muted-foreground" aria-label="How to connect">
              <li>Copy the address you use to open Home Assistant away from home, such as your Nabu Casa address. Only the start of it is needed (https://…ui.nabu.casa).</li>
              <li>In Home Assistant, open your profile (bottom left), then the Security tab.</li>
              <li>Under Long-lived access tokens, choose Create token, name it HomeHub, and copy it. Home Assistant shows it only once.</li>
              <li>Paste both below and choose Test and connect.</li>
            </ol>
            <details className="rounded-md border px-3 text-sm">
              <summary className="flex min-h-[var(--target-min)] cursor-pointer items-center font-medium">Why does it need https?</summary>
              <p className="pb-3 text-muted-foreground">
                HomeHub connects from the internet, not from inside your home, so addresses like homeassistant.local or 192.168.x.x can&apos;t be reached.
                https keeps your token private on the way. Nabu Casa, or a reverse proxy with a certificate, gives you such an address.
              </p>
            </details>
            <FormField
              control={form.control}
              name="url"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Home Assistant address</FormLabel>
                  <FormControl>
                    <Input placeholder="https://your-home.ui.nabu.casa" inputMode="url" autoComplete="off" {...field} />
                  </FormControl>
                  <FormDescription>An https address that works away from home. Any path after the address is ignored.</FormDescription>
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
                  <FormDescription>Stored on HomeHub&apos;s server only; it never reaches anyone&apos;s browser.</FormDescription>
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
