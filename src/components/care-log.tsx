"use client";

import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { zodResolver } from '@hookform/resolvers/zod';
import { format } from 'date-fns';
import { PlusCircle, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from '@/components/ui/form';
import { Textarea } from '@/components/ui/textarea';
import { Input } from '@/components/ui/input';
import { useToast } from '@/hooks/use-toast';
import { useAuth } from '@/hooks/use-auth';
import { playFeedback } from '@/lib/feedback';
import { loggerName, readableLogDate } from '@/lib/pets/care';
import type { PetCareLog } from '@/lib/pets/types';
import { Skeleton } from './ui/skeleton';
import { PetLogDeleteAlert } from './pet-log-delete-alert';
import { LoggedBy } from './pets/logged-by';
import { addPetLog, deletePetLog, usePetLogs } from './pets/pet-log-api';
import { unavailableText } from '@/lib/pets/live-listener';

const logSchema = z.object({
  activity: z.string().trim().min(3, 'Describe the activity (at least 3 characters).').max(80, 'Keep the activity under 80 characters.'),
  notes: z.string().max(500, 'Keep notes under 500 characters.').optional(),
});

type LogValues = z.infer<typeof logSchema>;

interface CareLogProps {
  petId: string;
}

export function CareLogClient({ petId }: CareLogProps) {
  const { currentUser, permissions } = useAuth();
  const { toast, toastError } = useToast();
  const canAdd = Boolean(permissions['pets.addLogs']);
  const canDelete = Boolean(permissions['pets.deleteLogs']);
  const householdId = currentUser?.householdId ?? null;
  const { logs, loading, error, failure } = usePetLogs<PetCareLog>(householdId, petId, 'care-logs', 100);
  const [logToDelete, setLogToDelete] = useState<string | null>(null);
  const [formOpen, setFormOpen] = useState(false);

  const form = useForm<LogValues>({
    resolver: zodResolver(logSchema),
    defaultValues: { activity: '', notes: '' },
  });

  const onSubmit = async (values: LogValues) => {
    if (!householdId || !currentUser) return;
    try {
      await addPetLog(householdId, petId, 'care-logs', {
        date: new Date().toISOString(),
        activity: values.activity,
        notes: values.notes || '',
        loggedByUid: currentUser.uid,
        loggedByName: loggerName(currentUser),
      });
      playFeedback('complete');
      form.reset({ activity: '', notes: '' });
      setFormOpen(false);
      toast({ title: 'Care logged', description: values.activity });
    } catch (submitError) {
      toastError(submitError, "Couldn't log the activity");
    }
  };

  const deleteLog = async (logId: string) => {
    if (!householdId) return;
    try {
      await deletePetLog(householdId, petId, 'care-logs', logId);
      toast({ title: 'Log removed' });
    } catch (deleteError) {
      toastError(deleteError, "Couldn't remove the log");
    }
  };

  return (
    <>
    <PetLogDeleteAlert
      open={!!logToDelete}
      logType="care"
      onCancel={() => setLogToDelete(null)}
      onConfirm={() => {
        if (!logToDelete) return;
        void deleteLog(logToDelete);
        setLogToDelete(null);
      }}
    />
    <Card>
      <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-3 space-y-0">
        <div className="space-y-1.5">
          <CardTitle className="font-headline">General Care Log</CardTitle>
          <CardDescription>Grooming, walks, vet visits and other care.</CardDescription>
        </div>
        {canAdd && !formOpen && (
          <Button type="button" variant="outline" size="sm" onClick={() => setFormOpen(true)}>
            <PlusCircle className="mr-2 h-4 w-4" /> Log care
          </Button>
        )}
      </CardHeader>
      <CardContent className="space-y-6">
        {canAdd && formOpen && (
          <Form {...form}>
            <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4 rounded-lg border p-4" aria-label="Log a care activity">
              <FormField
                control={form.control}
                name="activity"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Activity</FormLabel>
                    <FormControl>
                      <Input placeholder="e.g. Vet Visit, Nail Trim" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="notes"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Notes (Optional)</FormLabel>
                    <FormControl>
                      <Textarea placeholder="e.g. Annual checkup, all clear." rows={2} {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <div className="flex flex-wrap gap-2">
                <Button type="submit" size="sm" disabled={form.formState.isSubmitting}><PlusCircle className="mr-2 h-4 w-4" /> Save activity</Button>
                <Button type="button" size="sm" variant="ghost" onClick={() => setFormOpen(false)}>Cancel</Button>
              </div>
            </form>
          </Form>
        )}

        <section className="space-y-3" aria-labelledby={`care-history-${petId}`}>
          <h3 id={`care-history-${petId}`} className="font-semibold">History</h3>
          {loading && (
            <div className="space-y-2">
              <Skeleton className="h-16 w-full" />
              <Skeleton className="h-16 w-full" />
            </div>
          )}
          {!loading && error ? (
            <p className="py-4 text-center text-sm text-muted-foreground">{unavailableText('Care history', failure ?? 'retrying')}</p>
          ) : null}
          {!loading && !error && logs.length === 0 && (
            <p className="py-4 text-center text-sm text-muted-foreground">No care logged yet.</p>
          )}
          {!loading && logs.map((log) => {
            // A blank or unreadable legacy date renders as unknown, never a crash (PE-8c).
            const when = readableLogDate(log.date);
            return (
            <div key={log.id} className="flex items-start justify-between gap-3 rounded-md bg-secondary/50 p-3 text-sm">
              <div className="min-w-0 space-y-0.5">
                <p className="break-words font-semibold text-foreground">{log.activity}</p>
                <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-muted-foreground">
                  <span>{when ? format(when, 'PPP p') : 'Unknown time'}</span>
                  <LoggedBy entry={log} />
                </p>
                {log.notes && <p className="mt-1 text-muted-foreground">{log.notes}</p>}
              </div>
              {canDelete && (
                <Button variant="ghost" size="icon" aria-label={`Delete ${log.activity} care log`} className="h-8 w-8 flex-shrink-0" onClick={() => setLogToDelete(log.id)}>
                  <Trash2 className="h-4 w-4" />
                </Button>
              )}
            </div>
            );
          })}
        </section>
      </CardContent>
    </Card>
    </>
  );
}
