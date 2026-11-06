"use client";

import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { zodResolver } from '@hookform/resolvers/zod';
import { format } from 'date-fns';
import { PlusCircle, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Form, FormControl, FormDescription, FormField, FormItem, FormLabel, FormMessage } from '@/components/ui/form';
import { Textarea } from '@/components/ui/textarea';
import { Input } from '@/components/ui/input';
import { useToast } from '@/hooks/use-toast';
import { useAuth } from '@/hooks/use-auth';
import { playFeedback } from '@/lib/feedback';
import { loggerName, nextMedication, parseLocalDate } from '@/lib/pets/care';
import type { PetMedicationLog } from '@/lib/pets/types';
import { Skeleton } from './ui/skeleton';
import { PetLogDeleteAlert } from './pet-log-delete-alert';
import { LoggedBy } from './pets/logged-by';
import { MedicationChip } from './pets/medication-chip';
import { addPetLog, deletePetLog, useMedicationCountdownLogs, usePetLogs } from './pets/pet-log-api';
import { useNow } from './pets/use-now';

const logSchema = z.object({
  medication: z.string().trim().min(2, 'Enter the medication name.').max(80, 'Keep the name under 80 characters.'),
  dosage: z.string().trim().min(1, 'Enter the dosage.').max(80, 'Keep the dosage under 80 characters.'),
  nextDueDate: z
    .string()
    .optional()
    .refine((value) => !value || parseLocalDate(value) !== null, 'Pick a valid date.'),
  notes: z.string().max(500, 'Keep notes under 500 characters.').optional(),
});

type LogValues = z.infer<typeof logSchema>;

interface MedicationLogProps {
  petId: string;
}

export function MedicationLogClient({ petId }: MedicationLogProps) {
  const { currentUser, permissions } = useAuth();
  const { toast, toastError } = useToast();
  const now = useNow();
  const canAdd = Boolean(permissions['pets.addLogs']);
  const canDelete = Boolean(permissions['pets.deleteLogs']);
  const householdId = currentUser?.householdId ?? null;
  const { logs, loading, error } = usePetLogs<PetMedicationLog>(householdId, petId, 'medication-logs', 100);
  const [logToDelete, setLogToDelete] = useState<string | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const pending = useMedicationCountdownLogs(householdId, petId);
  // A failed countdown load is "unavailable", never "nothing due".
  const due = pending.loading || pending.error ? null : nextMedication(pending.logs, now);

  const form = useForm<LogValues>({
    resolver: zodResolver(logSchema),
    defaultValues: { medication: '', dosage: '', nextDueDate: '', notes: '' },
  });

  const onSubmit = async (values: LogValues) => {
    if (!householdId || !currentUser) return;
    const entry: Record<string, unknown> = {
      date: new Date().toISOString(),
      medication: values.medication,
      dosage: values.dosage,
      notes: values.notes || '',
      loggedByUid: currentUser.uid,
      loggedByName: loggerName(currentUser),
    };
    if (values.nextDueDate) entry.nextDueDate = values.nextDueDate;
    try {
      await addPetLog(householdId, petId, 'medication-logs', entry);
      playFeedback('complete');
      form.reset({ medication: '', dosage: '', nextDueDate: '', notes: '' });
      setFormOpen(false);
      toast({ title: 'Medication logged', description: `${values.medication}, ${values.dosage}.` });
    } catch (submitError) {
      toastError(submitError, "Couldn't log the medication");
    }
  };

  const deleteLog = async (logId: string) => {
    if (!householdId) return;
    try {
      await deletePetLog(householdId, petId, 'medication-logs', logId);
      toast({ title: 'Log removed' });
    } catch (deleteError) {
      toastError(deleteError, "Couldn't remove the log");
    }
  };

  return (
    <>
    <PetLogDeleteAlert
      open={!!logToDelete}
      logType="medication"
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
          <CardTitle className="font-headline">Medication Log</CardTitle>
          <CardDescription>Doses given, and when the next one is due.</CardDescription>
        </div>
        {canAdd && !formOpen && (
          <Button type="button" variant="outline" size="sm" onClick={() => setFormOpen(true)}>
            <PlusCircle className="mr-2 h-4 w-4" /> Log a dose
          </Button>
        )}
      </CardHeader>
      <CardContent className="space-y-6">
        {pending.error ? (
          <p className="text-sm text-muted-foreground">Next dose is unavailable right now.</p>
        ) : null}
        {due && (
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <span className="text-muted-foreground">Next dose:</span>
            <MedicationChip due={due} />
          </div>
        )}

        {canAdd && formOpen && (
          <Form {...form}>
            <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4 rounded-lg border p-4" aria-label="Log a medication dose">
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <FormField
                  control={form.control}
                  name="medication"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Medication</FormLabel>
                      <FormControl>
                        <Input placeholder="e.g. Flea & Tick" {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="dosage"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Dosage</FormLabel>
                      <FormControl>
                        <Input placeholder="e.g. 1 tablet" {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </div>
              <FormField
                control={form.control}
                name="nextDueDate"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Next dose due (Optional)</FormLabel>
                    <FormControl>
                      <Input type="date" min={format(now, 'yyyy-MM-dd')} className="sm:max-w-[220px]" {...field} />
                    </FormControl>
                    <FormDescription>Shows a countdown on the pet&apos;s card.</FormDescription>
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
                      <Textarea placeholder="e.g. Hidden in cheese." rows={2} {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <div className="flex flex-wrap gap-2">
                <Button type="submit" size="sm" disabled={form.formState.isSubmitting}><PlusCircle className="mr-2 h-4 w-4" /> Save dose</Button>
                <Button type="button" size="sm" variant="ghost" onClick={() => setFormOpen(false)}>Cancel</Button>
              </div>
            </form>
          </Form>
        )}

        <section className="space-y-3" aria-labelledby={`medication-history-${petId}`}>
          <h3 id={`medication-history-${petId}`} className="font-semibold">History</h3>
          {loading && (
            <div className="space-y-2">
              <Skeleton className="h-16 w-full" />
              <Skeleton className="h-16 w-full" />
            </div>
          )}
          {!loading && error ? (
            <p className="py-4 text-center text-sm text-muted-foreground">Medication history is unavailable right now.</p>
          ) : null}
          {!loading && !error && logs.length === 0 && (
            <p className="py-4 text-center text-sm text-muted-foreground">No medication logged yet.</p>
          )}
          {!loading && logs.map((log) => {
            const nextDue = parseLocalDate(log.nextDueDate);
            return (
              <div key={log.id} className="flex items-start justify-between gap-3 rounded-md bg-secondary/50 p-3 text-sm">
                <div className="min-w-0 space-y-0.5">
                  <p className="text-foreground"><span className="font-semibold">{log.medication}</span> · {log.dosage}</p>
                  <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-muted-foreground">
                    <span>{format(new Date(log.date), 'PPP p')}</span>
                    <LoggedBy entry={log} />
                  </p>
                  {nextDue && <p className="text-muted-foreground">Next dose {format(nextDue, 'PPP')}</p>}
                  {log.notes && <p className="mt-1 text-muted-foreground">{log.notes}</p>}
                </div>
                {canDelete && (
                  <Button variant="ghost" size="icon" aria-label={`Delete ${log.medication} medication log`} className="h-8 w-8 flex-shrink-0" onClick={() => setLogToDelete(log.id)}>
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
