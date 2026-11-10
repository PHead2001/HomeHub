"use client";

import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { zodResolver } from '@hookform/resolvers/zod';
import { format, parse } from 'date-fns';
import { CalendarIcon, ChevronDown, Loader2, PlusCircle, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from '@/components/ui/form';
import { Textarea } from '@/components/ui/textarea';
import { useToast } from '@/hooks/use-toast';
import { useAuth } from '@/hooks/use-auth';
import { playFeedback } from '@/lib/feedback';
import { formatPortion, isValidPortion, knownFoodType, PORTION_MAX, type FeedingPlan } from '@/lib/pets/care';
import { authorMayDelete, knownFromLogs } from '@/lib/pets/feed-decision';
import { undoFeed } from '@/lib/pets/feed-operation';
import { FOOD_TYPES, PORTION_UNITS, type FoodType, type PetFeedingLog } from '@/lib/pets/types';
import { cn } from '@/lib/utils';
import { Skeleton } from './ui/skeleton';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './ui/select';
import { RadioGroup, RadioGroupItem } from './ui/radio-group';
import { Popover, PopoverContent, PopoverTrigger } from './ui/popover';
import { Calendar } from './ui/calendar';
import { Checkbox } from './ui/checkbox';
import { Input } from './ui/input';
import { PetLogDeleteAlert } from './pet-log-delete-alert';
import { LoggedBy } from './pets/logged-by';
import { usePetLogs } from './pets/pet-log-api';
import { FeedAgainDialog, useFeedAction } from './pets/use-feed-action';
import { useNow } from './pets/use-now';

const logSchema = z.object({
  date: z.date(),
  time: z.string().regex(/^(0?[1-9]|1[0-2]):[0-5][0-9]$/, "Use the hh:mm format, e.g. 7:30."),
  ampm: z.enum(['AM', 'PM']),
  // Accepts every planned portion (e.g. "1/3 cup" → 0.33), so the default always validates.
  cups: z.coerce
    .number<number>({ error: 'Enter an amount.' })
    .refine(isValidPortion, `Use an amount above 0 and up to ${PORTION_MAX}.`),
  foodAmountType: z.enum(PORTION_UNITS),
  foodType: z.enum(FOOD_TYPES),
  comments: z.string().max(500, 'Keep comments under 500 characters.').optional(),
});

type LogValues = z.infer<typeof logSchema>;

interface FeedingLogProps {
  petId: string;
  /** For the "Feed again?" question and toasts. */
  petName?: string;
  /** Planned portion; the form defaults to it (section 3: no more "1" when the plan says 1.5). */
  plan: FeedingPlan;
}

function defaults(plan: FeedingPlan, foodType: FoodType = 'Dry'): LogValues {
  const now = new Date();
  return {
    date: now,
    time: format(now, 'hh:mm'),
    ampm: format(now, 'a').toUpperCase() as 'AM' | 'PM',
    cups: plan.amount,
    foodAmountType: plan.unit,
    foodType,
    comments: '',
  };
}

/** A chosen time within a minute of now is a live feeding, not a backdated one. */
const BACKDATE_MARGIN_MS = 60_000;

/** `future`: refuse; otherwise the backdated time, or undefined for a live feeding. */
function backdateFor(chosen: Date | null): { future: true } | { future: false; backdatedAt?: Date } {
  if (!chosen) return { future: false };
  const nowMs = Date.now();
  if (chosen.getTime() > nowMs + BACKDATE_MARGIN_MS) return { future: true };
  return { future: false, backdatedAt: chosen.getTime() < nowMs - BACKDATE_MARGIN_MS ? chosen : undefined };
}

export function FeedingLogClient({ petId, petName = 'This pet', plan }: FeedingLogProps) {
  const { currentUser, permissions, household } = useAuth();
  const { toast, toastError } = useToast();
  const now = useNow();
  const canAdd = Boolean(permissions['pets.addLogs']);
  const canDelete = Boolean(permissions['pets.deleteLogs']);
  const householdId = currentUser?.householdId ?? null;
  const { logs, loading, error } = usePetLogs<PetFeedingLog>(householdId, petId, 'feeding-logs', 100);
  const [useCurrentTime, setUseCurrentTime] = useState(true);
  const [logToDelete, setLogToDelete] = useState<string | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const lastFoodType = knownFoodType(logs[0]?.foodType);
  // Every feeding, live or backdated, goes through the shared feed operation.
  const feeding = useFeedAction(petId, petName, {
    onFed: () => {
      playFeedback('complete');
      setFormOpen(false);
    },
    describe: () => {
      const values = form.getValues();
      return { title: 'Feeding logged', description: `${formatPortion(values.cups, values.foodAmountType)} of ${values.foodType.toLowerCase()} food.` };
    },
  });

  const form = useForm<LogValues>({
    resolver: zodResolver(logSchema),
    defaultValues: defaults(plan, lastFoodType),
  });

  const openForm = () => {
    form.reset(defaults(plan, lastFoodType));
    setUseCurrentTime(true);
    setFormOpen(true);
  };

  const onSubmit = async (values: LogValues) => {
    if (!householdId || !currentUser) return;
    const chosen = useCurrentTime
      ? null
      : parse(`${format(values.date, 'yyyy-MM-dd')} ${values.time} ${values.ampm}`, 'yyyy-MM-dd hh:mm a', new Date());
    const when = backdateFor(chosen);
    if (when.future) {
      form.setError('time', { message: 'Pick a time that has already passed.' });
      return;
    }
    // A chosen past time is a backdated entry (its own date, no "Feed again?");
    // otherwise the feeding is live (server time) and runs the last-fed check.
    const { backdatedAt } = when;
    await feeding.run({
      portion: { amount: values.cups, unit: values.foodAmountType },
      food: values.foodType,
      comments: values.comments ?? '',
      backdatedAt,
      known: loading || error ? null : knownFromLogs(logs, now, household?.timeZone),
    });
  };

  const deleteLog = async (logId: string) => {
    if (!householdId) return;
    try {
      // Keeps feeding-state in step (restores the previous feed when this was the latest).
      await undoFeed({ householdId, petId, logId, timeZone: household?.timeZone, onLateError: (lateError) => toastError(lateError, "Couldn't remove the log") });
      toast({ title: 'Log removed' });
    } catch (deleteError) {
      toastError(deleteError, "Couldn't remove the log");
    }
  };

  return (
    <>
    <FeedAgainDialog action={feeding} petName={petName} />
    <PetLogDeleteAlert
      open={!!logToDelete}
      logType="feeding"
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
          <CardTitle className="font-headline">Feeding Log</CardTitle>
          <CardDescription>Who fed, when, and how much.</CardDescription>
        </div>
        {canAdd && !formOpen && (
          <Button type="button" variant="outline" size="sm" onClick={openForm}>
            <PlusCircle className="mr-2 h-4 w-4" /> Log with details
          </Button>
        )}
      </CardHeader>
      <CardContent className="space-y-6">
        {canAdd && formOpen && (
          <Form {...form}>
            <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4 rounded-lg border p-4" aria-label="Log a feeding with details">
              <div className="flex items-center space-x-2">
                <Checkbox id="useCurrentTime" checked={useCurrentTime} onCheckedChange={(checked) => setUseCurrentTime(!!checked)} />
                <label htmlFor="useCurrentTime" className="text-sm font-medium leading-none">Use current time</label>
              </div>

              {!useCurrentTime && (
                <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                  <FormField
                    control={form.control}
                    name="date"
                    render={({ field }) => (
                      <FormItem className="flex flex-col">
                        <FormLabel>Date</FormLabel>
                        <Popover>
                          <PopoverTrigger asChild>
                            <FormControl>
                              <Button variant="outline" className={cn('w-full pl-3 text-left font-normal', !field.value && 'text-muted-foreground')}>
                                {field.value ? format(field.value, 'PPP') : <span>Pick a date</span>}
                                <CalendarIcon className="ml-auto h-4 w-4 opacity-50" />
                              </Button>
                            </FormControl>
                          </PopoverTrigger>
                          <PopoverContent className="w-auto p-0" align="start">
                            <Calendar
                              mode="single"
                              selected={field.value}
                              onSelect={field.onChange}
                              disabled={(date) => date > new Date() || date < new Date('1900-01-01')}
                              initialFocus
                            />
                          </PopoverContent>
                        </Popover>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  <div className="grid grid-cols-3 items-end gap-2">
                    <div className="col-span-2">
                      <FormField
                        control={form.control}
                        name="time"
                        render={({ field }) => (
                          <FormItem>
                            <FormLabel>Time</FormLabel>
                            <FormControl>
                              <Input placeholder="hh:mm" {...field} />
                            </FormControl>
                            <FormMessage />
                          </FormItem>
                        )}
                      />
                    </div>
                    <FormField
                      control={form.control}
                      name="ampm"
                      render={({ field }) => (
                        <FormItem>
                          <FormControl>
                            <RadioGroup onValueChange={field.onChange} value={field.value} className="flex items-center space-x-2" aria-label="AM or PM">
                              <FormItem className="flex items-center space-x-1 space-y-0">
                                <FormControl><RadioGroupItem value="AM" /></FormControl>
                                <FormLabel className="text-xs font-normal">AM</FormLabel>
                              </FormItem>
                              <FormItem className="flex items-center space-x-1 space-y-0">
                                <FormControl><RadioGroupItem value="PM" /></FormControl>
                                <FormLabel className="text-xs font-normal">PM</FormLabel>
                              </FormItem>
                            </RadioGroup>
                          </FormControl>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                  </div>
                </div>
              )}

              <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                <FormField
                  control={form.control}
                  name="cups"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Amount</FormLabel>
                      <FormControl>
                        <Input type="number" inputMode="decimal" min={0.01} max={PORTION_MAX} step="any" {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="foodAmountType"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Unit</FormLabel>
                      <Select onValueChange={field.onChange} value={field.value}>
                        <FormControl>
                          <SelectTrigger>
                            <SelectValue placeholder="Select a unit" />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          {PORTION_UNITS.map((unit) => <SelectItem key={unit} value={unit}>{unit}</SelectItem>)}
                        </SelectContent>
                      </Select>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </div>
              <FormField
                control={form.control}
                name="foodType"
                render={({ field }) => (
                  <FormItem className="space-y-3">
                    <FormLabel>Food Type</FormLabel>
                    <FormControl>
                      <RadioGroup onValueChange={field.onChange} value={field.value} className="flex items-center space-x-4">
                        {FOOD_TYPES.map((type) => (
                          <FormItem key={type} className="flex items-center space-x-2 space-y-0">
                            <FormControl><RadioGroupItem value={type} /></FormControl>
                            <FormLabel className="font-normal">{type}</FormLabel>
                          </FormItem>
                        ))}
                      </RadioGroup>
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="comments"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Comments (Optional)</FormLabel>
                    <FormControl>
                      <Textarea placeholder="e.g. Mixed with a little water." rows={2} {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <div className="flex flex-wrap gap-2">
                <Button type="submit" size="sm" disabled={form.formState.isSubmitting || feeding.saving}>
                  {feeding.saving ? <Loader2 aria-hidden className="mr-2 h-4 w-4 animate-spin" /> : <PlusCircle className="mr-2 h-4 w-4" />} Save feeding
                </Button>
                <Button type="button" size="sm" variant="ghost" onClick={() => setFormOpen(false)}>
                  <ChevronDown className="mr-2 h-4 w-4 rotate-180" /> Cancel
                </Button>
              </div>
            </form>
          </Form>
        )}

        <section className="space-y-3" aria-labelledby={`feeding-history-${petId}`}>
          <h3 id={`feeding-history-${petId}`} className="font-semibold">History</h3>
          {loading && (
            <div className="space-y-2">
              <Skeleton className="h-14 w-full" />
              <Skeleton className="h-14 w-full" />
            </div>
          )}
          {!loading && error ? (
            <p className="py-4 text-center text-sm text-muted-foreground">Feeding history is unavailable right now.</p>
          ) : null}
          {!loading && !error && logs.length === 0 && (
            <p className="py-4 text-center text-sm text-muted-foreground">No feedings logged yet.</p>
          )}
          {!loading && logs.map((log) => {
            const when = format(new Date(log.date), 'PPP p');
            return (
              <div key={log.id} className="flex items-start justify-between gap-3 rounded-md bg-secondary/50 p-3 text-sm">
                <div className="min-w-0 space-y-0.5">
                  <p className="font-semibold text-foreground">
                    {formatPortion(Number(log.cups) || 0, log.foodAmountType)} of {String(log.foodType || 'dry').toLowerCase()} food
                  </p>
                  <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-muted-foreground">
                    <span>{when}</span>
                    <LoggedBy entry={log} />
                  </p>
                  {log.comments && <p className="mt-1 text-muted-foreground">{log.comments}</p>}
                </div>
                {/* pets.deleteLogs, or the author within 10 minutes of logging (PE-2). */}
                {(canDelete || authorMayDelete(log, currentUser?.uid, now)) && (
                  <Button variant="ghost" size="icon" aria-label={`Delete feeding log from ${when}`} className="h-8 w-8 flex-shrink-0" onClick={() => setLogToDelete(log.id)}>
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
