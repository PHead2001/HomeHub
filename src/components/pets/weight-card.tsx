'use client';

import { useState } from 'react';
import { format } from 'date-fns';
import { ArrowDownRight, ArrowUpRight, Loader2, Minus, PlusCircle, Scale, Trash2 } from 'lucide-react';
import { useAuth } from '@/hooks/use-auth';
import { useToast } from '@/hooks/use-toast';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { FieldError, fieldErrorProps } from '@/components/field-error';
import { PetLogDeleteAlert } from '@/components/pet-log-delete-alert';
import { householdDayStart, householdToday } from '@/lib/household-day';
import { loggerName } from '@/lib/pets/care';
import { unavailableText } from '@/lib/pets/live-listener';
import { newRecordOpId } from '@/lib/pets/notes';
import { mayDeleteWeight, mayPet } from '@/lib/pets/pet-actions';
import type { PetProfile } from '@/lib/pets/types';
import {
  WEIGHT_UNITS,
  WEIGHT_UNIT_LABELS,
  formatWeight,
  petWeightUnit,
  sparklinePoints,
  validateWeightDraft,
  weightHistory,
  weightIn,
  weightTrend,
  type WeightDraft,
  type WeightDraftErrors,
  type WeightEntry,
} from '@/lib/pets/weights';
import { LoggedBy } from './logged-by';
import { LoadMoreHistory } from './load-more';
import { useHistoryWindow } from './pet-log-api';
import { createWeight, deleteWeight, usePetWeights } from './records-api';
import { useNow } from './use-now';

const SPARK_W = 120;
const SPARK_H = 32;
/** The trend reads the newest weighings; history pages start here and grow by the same step. */
const WEIGHT_PAGE = 10;

/** The effective time of a weighing: now for today, noon (household time) of an earlier household day. */
function weighingDate(day: string, now: Date, timeZone: string | null): Date {
  const today = householdToday(timeZone, now);
  if (!day || day >= today) return now;
  return new Date(householdDayStart(timeZone, day).getTime() + 12 * 3_600_000);
}

type AddForm = { opId: string; draft: WeightDraft; errors: WeightDraftErrors; submitted: boolean };

/**
 * Weight on the pet page (PE-28b/c, D-P10): the latest weighing, a trend in
 * words with an arrow (never colour alone) and a small sparkline, a "Log
 * weight" form (one add, one entry), and the history in the pet's unit
 * (entries in the other unit converted), paginated.
 */
export function WeightCard({ pet }: { pet: PetProfile }) {
  const { currentUser, permissions, household } = useAuth();
  const { toast, toastError } = useToast();
  const now = useNow();
  const timeZone = household?.timeZone ?? null;
  const today = householdToday(timeZone, now);
  const householdId = currentUser?.householdId ?? null;
  const unit = petWeightUnit(pet);
  const history = useHistoryWindow(pet.id, WEIGHT_PAGE);
  const weights = usePetWeights(householdId, pet.id, history.max);
  const entries = weightHistory(weights.items);
  const trend = weights.loading || weights.error ? null : weightTrend(weights.items, unit, { timeZone });
  const canAdd = mayPet('pets.weight.add', permissions);
  const actor = { uid: currentUser?.uid, permissions };

  const [adding, setAdding] = useState<AddForm | null>(null);
  const [saving, setSaving] = useState(false);
  const [toDelete, setToDelete] = useState<WeightEntry | null>(null);

  const change = (patch: Partial<WeightDraft>) => setAdding((form) => {
    if (!form) return form;
    const draft = { ...form.draft, ...patch };
    return { ...form, draft, errors: form.submitted ? validateWeightDraft(draft, today) : form.errors };
  });

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!adding || !householdId || !currentUser || saving) return;
    const errors = validateWeightDraft(adding.draft, today);
    if (Object.keys(errors).length > 0) {
      setAdding({ ...adding, errors, submitted: true });
      document.getElementById(errors.value ? `weight-value-${pet.id}` : `weight-day-${pet.id}`)?.focus();
      return;
    }
    setSaving(true);
    try {
      const outcome = await createWeight({
        householdId,
        petId: pet.id,
        opId: adding.opId,
        value: Number(adding.draft.value),
        unit: adding.draft.unit,
        date: weighingDate(adding.draft.day, new Date(), timeZone),
        author: { uid: currentUser.uid, name: loggerName(currentUser) },
        onLateError: (error) => toastError(error, "Couldn't save the weight"),
      });
      toast(outcome === 'queued'
        ? { title: 'Saved on this device', description: 'The weight will sync when you are back online.' }
        : { title: 'Weight logged', description: formatWeight(Number(adding.draft.value), adding.draft.unit) });
      setAdding(null);
    } catch (error) {
      toastError(error, "Couldn't save the weight");
    } finally {
      setSaving(false);
    }
  };

  const remove = async (entry: WeightEntry) => {
    if (!householdId) return;
    try {
      await deleteWeight({ householdId, petId: pet.id, weightId: entry.id, onLateError: (error) => toastError(error, "Couldn't remove the weight") });
      toast({ title: 'Weight removed' });
    } catch (error) {
      toastError(error, "Couldn't remove the weight");
    }
  };

  const TrendIcon = trend?.direction === 'up' ? ArrowUpRight : trend?.direction === 'down' ? ArrowDownRight : Minus;

  return (
    <>
      <PetLogDeleteAlert
        open={!!toDelete}
        logType="weight"
        onCancel={() => setToDelete(null)}
        onConfirm={() => {
          if (toDelete) void remove(toDelete);
          setToDelete(null);
        }}
      />
      <Card data-testid="weight-card">
        <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-3 space-y-0">
          <CardTitle className="flex items-center gap-2 font-headline text-xl">
            <Scale aria-hidden className="h-4 w-4 text-muted-foreground" /> Weight
          </CardTitle>
          {canAdd && !adding && (
            <Button type="button" variant="outline" size="sm" onClick={() => setAdding({ opId: newRecordOpId(), draft: { value: '', unit, day: '' }, errors: {}, submitted: false })}>
              <PlusCircle className="mr-2 h-4 w-4" /> Log weight
            </Button>
          )}
        </CardHeader>
        <CardContent className="space-y-4 text-sm">
          {adding && (
            <form onSubmit={submit} noValidate className="space-y-3 rounded-lg border p-3" aria-label="Log a weight">
              <div className="flex flex-wrap items-start gap-3">
                <div className="grid gap-2">
                  <Label htmlFor={`weight-value-${pet.id}`}>Weight</Label>
                  <div className="flex gap-2">
                    <Input
                      type="number"
                      inputMode="decimal"
                      step="any"
                      min={0.01}
                      className="w-28"
                      value={adding.draft.value}
                      onChange={(event) => change({ value: event.target.value })}
                      {...fieldErrorProps(`weight-value-${pet.id}`, adding.errors.value)}
                    />
                    <Select value={adding.draft.unit} onValueChange={(next) => change({ unit: next as WeightDraft['unit'] })}>
                      <SelectTrigger className="w-20" aria-label="Weight unit"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        {WEIGHT_UNITS.map((option) => <SelectItem key={option} value={option}>{WEIGHT_UNIT_LABELS[option]}</SelectItem>)}
                      </SelectContent>
                    </Select>
                  </div>
                </div>
                <div className="grid gap-2">
                  <Label htmlFor={`weight-day-${pet.id}`}>Date</Label>
                  <Input
                    type="date"
                    className="w-44"
                    max={today}
                    value={adding.draft.day || today}
                    onChange={(event) => change({ day: event.target.value })}
                    {...fieldErrorProps(`weight-day-${pet.id}`, adding.errors.day)}
                  />
                </div>
              </div>
              <FieldError id={`weight-value-${pet.id}`}>{adding.errors.value}</FieldError>
              <FieldError id={`weight-day-${pet.id}`}>{adding.errors.day}</FieldError>
              <div className="flex justify-end gap-2">
                <Button type="button" variant="outline" disabled={saving} onClick={() => setAdding(null)}>Cancel</Button>
                <Button type="submit" disabled={saving}>
                  {saving && <Loader2 aria-hidden className="mr-2 h-4 w-4 animate-spin" />}
                  Save weight
                </Button>
              </div>
            </form>
          )}

          {weights.loading && <Skeleton className="h-16 w-full" />}
          {!weights.loading && weights.error ? (
            <p className="text-muted-foreground">{unavailableText('Weight history', weights.failure ?? 'retrying')}</p>
          ) : null}
          {!weights.loading && !weights.error && !trend && <p className="text-muted-foreground">No weight logged yet.</p>}
          {trend && (
            <div className="flex items-center justify-between gap-3" data-testid="weight-trend">
              <div className="min-w-0">
                <p className="text-2xl font-semibold text-foreground">{formatWeight(trend.latest.value, unit)}</p>
                <p className="flex items-center gap-1 text-muted-foreground">
                  <TrendIcon aria-hidden className="h-4 w-4 flex-shrink-0" />
                  <span>{trend.summary}</span>
                </p>
              </div>
              {trend.series.length > 1 && (
                <svg width={SPARK_W} height={SPARK_H} viewBox={`0 0 ${SPARK_W} ${SPARK_H}`} aria-hidden className="flex-shrink-0 text-primary">
                  <polyline points={sparklinePoints(trend.series, SPARK_W, SPARK_H)} fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
                </svg>
              )}
            </div>
          )}

          {!weights.loading && !weights.error && entries.length > 0 && (
            <ul className="space-y-2" aria-label={`Weight history in ${WEIGHT_UNIT_LABELS[unit]}`}>
              {entries.map((entry) => {
                const shown = formatWeight(weightIn(entry, unit), unit);
                const when = entry.date ? format(entry.date, 'PPP') : 'Unknown date';
                return (
                  <li key={entry.id} className="flex items-center justify-between gap-3 rounded-md bg-secondary/50 px-3 py-2">
                    <div className="min-w-0">
                      <p className="font-medium text-foreground">
                        {shown}
                        {entry.unit !== unit && <span className="ml-1 text-xs text-muted-foreground">(logged as {formatWeight(entry.value, entry.unit)})</span>}
                      </p>
                      <p className="flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
                        <span>{when}</span>
                        <LoggedBy entry={{ loggedByUid: entry.loggedByUid ?? undefined, loggedByName: entry.loggedByName ?? undefined }} />
                      </p>
                    </div>
                    {mayDeleteWeight(entry, actor, now) && (
                      <Button variant="ghost" size="icon" className="h-8 w-8 flex-shrink-0" aria-label={`Delete the weight from ${when}`} onClick={() => setToDelete(entry)}>
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
          {!weights.loading && !weights.error && (
            <LoadMoreHistory hasMore={weights.hasMore} loadingMore={weights.loadingMore} onLoadMore={history.loadMore} what="weights" />
          )}
        </CardContent>
      </Card>
    </>
  );
}
