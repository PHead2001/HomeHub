'use client';

import * as React from 'react';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { FieldError, fieldErrorProps } from '@/components/field-error';
import { ImageUpload } from '@/components/image-upload';
import {
  FOOD_SCHEDULE_MAX,
  PET_NAME_MAX,
  PORTION_MAX,
  feedingPlan,
  parseFeedingsPerDay,
  parsePortion,
  speciesHintFor,
  UNIT_LABELS,
  validatePetForm,
  type FeedingPlan,
  type PetFormErrors,
  type PetFormValues,
} from '@/lib/pets/care';
import { draftFromPlan, readMealPlan, slotsFromDraft, validateMealDraft, type MealSlotDraft, type MealSlotErrors } from '@/lib/pets/meal-plan';
import { PET_SPECIES, PORTION_UNITS, type MealSlot, type PetProfile, type PortionUnit } from '@/lib/pets/types';
import { EMPTY_VET, VET_PHONE_MAX, VET_TEXT_MAX, validateVet, vetDraftFrom, vetFields, type VetDraft, type VetErrors } from '@/lib/pets/profile';
import { DEFAULT_WEIGHT_UNIT, WEIGHT_UNITS, WEIGHT_UNIT_LABELS, petWeightUnit, type WeightUnit } from '@/lib/pets/weights';
import { cn } from '@/lib/utils';
import { MealPlanEditor, mealFieldId } from './meal-plan-editor';

export type PetFormState = PetFormValues & {
  type: string;
  portionUnit: PortionUnit;
  /** Meal time rows (PE-22k); empty keeps the legacy daily count. */
  meals: MealSlotDraft[];
  /** The unit weights are shown in (PE-28c). */
  weightUnit: WeightUnit;
} & VetDraft;

export const EMPTY_PET_FORM: PetFormState = {
  name: '',
  type: 'Dog',
  foodSchedule: '',
  feedingsPerDay: '',
  portionAmount: '',
  portionUnit: 'Cups',
  meals: [],
  weightUnit: DEFAULT_WEIGHT_UNIT,
  ...EMPTY_VET,
};

export function petFormFromProfile(pet: PetProfile): PetFormState {
  const portion = parsePortion(pet.foodSchedule);
  return {
    name: pet.name,
    type: pet.type || 'Other',
    foodSchedule: pet.foodSchedule ?? '',
    feedingsPerDay: pet.feedingsPerDay ? String(pet.feedingsPerDay) : '',
    portionAmount: pet.portionAmount ? String(pet.portionAmount) : '',
    portionUnit: pet.portionUnit ?? portion?.unit ?? 'Cups',
    meals: draftFromPlan(readMealPlan(pet)),
    weightUnit: petWeightUnit(pet),
    ...vetDraftFrom(pet),
  };
}

/** Field errors of the whole form: the pet fields, each meal row, and the plan. */
export type PetDraftErrors = { fields: PetFormErrors; meals: MealSlotErrors[]; plan: string | null; vet: VetErrors };

/**
 * Validates the add and edit forms. With meal times the free-text schedule is
 * optional (notes) and the legacy count and portion are not used; a pet that
 * already has confirmed meal times keeps at least one (a plan cannot be removed).
 */
export function validatePetDraft(values: PetFormState, existingNames: string[] = [], original?: PetFormState, confirmed = false): PetDraftErrors {
  const fields = validatePetForm(values, existingNames, original, { hasMealTimes: values.meals.length > 0 });
  const meals = validateMealDraft(values.meals);
  const plan = meals.plan ?? (confirmed && values.meals.length === 0 ? 'Keep at least one meal time.' : null);
  const vet = validateVet(values, original);
  return { fields, meals: meals.rows, plan, vet };
}

export function hasDraftErrors(errors: PetDraftErrors): boolean {
  return Object.keys(errors.fields).length > 0 || errors.plan !== null || errors.meals.some((row) => Object.keys(row).length > 0)
    || Object.keys(errors.vet).length > 0;
}

export const NO_DRAFT_ERRORS: PetDraftErrors = { fields: {}, meals: [], plan: null, vet: {} };

/** Types offered in the picker: the known species plus any legacy value already stored. */
function typeOptions(current: string): string[] {
  return (PET_SPECIES as readonly string[]).includes(current) || !current ? [...PET_SPECIES] : [...PET_SPECIES, current];
}

/** Stops a click on a button without an explicit `type` from submitting the enclosing form. */
export function preventImplicitSubmit(event: React.MouseEvent<HTMLElement>) {
  const button = (event.target as HTMLElement).closest('button');
  if (button && event.currentTarget.contains(button) && !button.hasAttribute('type')) {
    event.preventDefault();
  }
}

export type PetFormFieldsProps = {
  idPrefix: string;
  values: PetFormState;
  errors: PetDraftErrors;
  onChange: (patch: Partial<PetFormState>) => void;
  onPhotoChange: (file: File | null) => void;
  existingPhotoUrl?: string;
  /** The picked photo is being shrunk (PE-21e). */
  photoBusy?: boolean;
  /** Why the picked photo can't be used (the shared downscale copy), or null. */
  photoError?: string | null;
  /** The stored pet (edit): its legacy target, and whether it already has confirmed meal times. */
  pet?: PetProfile | null;
};

/** Shared fields for the add and edit pet dialogs, with inline field errors. */
export function PetFormFields({ idPrefix, values, errors: draftErrors, onChange, onPhotoChange, existingPhotoUrl, photoBusy, photoError, pet }: PetFormFieldsProps) {
  const id = (field: string) => `${idPrefix}-${field}`;
  const errors = draftErrors.fields;
  const parsedPerDay = parseFeedingsPerDay(values.foodSchedule);
  const parsedPortion = parsePortion(values.foodSchedule);
  const confirmed = Boolean(pet && readMealPlan(pet));
  const legacy: FeedingPlan | null = pet && !confirmed ? feedingPlan(pet) : null;
  const withMeals = values.meals.length > 0;

  return (
    <div className="grid gap-4 py-2">
      <div className="grid gap-2">
        <p className="text-sm font-medium leading-none" id={id('photo-label')}>Photo</p>
        {/* The shared uploader's Remove button has no `type`, so inside the dialog form it
            would submit. Cancel only the submit default; its own click handler still runs.
            A rejected photo is pointed at (focus) instead of saving without it, as in the barcode library. */}
        <div
          id={id('photo')}
          tabIndex={-1}
          role="group"
          aria-labelledby={id('photo-label')}
          aria-describedby={photoError ? `${id('photo')}-error` : undefined}
          className={cn('rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-ring', photoError && 'ring-2 ring-destructive')}
          onClick={preventImplicitSubmit}
        >
          <ImageUpload
            onFileChange={onPhotoChange}
            existingImageUrl={existingPhotoUrl}
            previewAlt={values.name ? `Photo preview for ${values.name}` : 'New pet photo preview'}
          />
        </div>
        {photoError ? (
          <FieldError id={id('photo')}>{photoError}</FieldError>
        ) : (
          <p role="status" className="text-xs text-muted-foreground">
            {photoBusy ? 'Shrinking the photo…' : 'Optional. Without a photo, your pet gets an illustrated avatar.'}
          </p>
        )}
      </div>

      <div className="grid gap-2">
        <Label htmlFor={id('name')}>Name</Label>
        <Input
          value={values.name}
          maxLength={PET_NAME_MAX + 10}
          onChange={(event) => onChange({ name: event.target.value })}
          placeholder="Buddy"
          autoComplete="off"
          {...fieldErrorProps(id('name'), errors.name)}
        />
        <FieldError id={id('name')}>{errors.name}</FieldError>
      </div>

      <div className="grid gap-2">
        <Label htmlFor={id('type')}>Type</Label>
        <Select value={values.type} onValueChange={(type) => onChange({ type })}>
          <SelectTrigger id={id('type')}>
            <SelectValue placeholder="Select a type" />
          </SelectTrigger>
          <SelectContent>
            {typeOptions(values.type).map((option) => (
              <SelectItem key={option} value={option}>{option}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="grid gap-2">
        <Label htmlFor={id('schedule')}>{withMeals ? 'Food notes' : 'Food schedule'}</Label>
        <Textarea
          value={values.foodSchedule}
          maxLength={FOOD_SCHEDULE_MAX + 20}
          onChange={(event) => onChange({ foodSchedule: event.target.value })}
          placeholder={withMeals ? 'Optional, e.g. "Wet food at dinner"' : 'e.g. 1.5 cups at 8am and 6pm'}
          rows={2}
          {...fieldErrorProps(id('schedule'), errors.foodSchedule)}
        />
        <FieldError id={id('schedule')}>{errors.foodSchedule}</FieldError>
      </div>

      <MealPlanEditor
        idPrefix={idPrefix}
        rows={values.meals}
        errors={draftErrors.meals}
        planError={draftErrors.plan}
        schedule={values.foodSchedule}
        legacy={legacy}
        confirmed={confirmed}
        onChange={(meals) => onChange({ meals })}
      />

      {!withMeals && (
      <>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div className="grid gap-2">
          <Label htmlFor={id('per-day')}>Feedings per day</Label>
          <Input
            type="number"
            inputMode="numeric"
            min={1}
            max={12}
            step={1}
            value={values.feedingsPerDay}
            onChange={(event) => onChange({ feedingsPerDay: event.target.value })}
            placeholder={parsedPerDay ? String(parsedPerDay) : 'e.g. 2'}
            {...fieldErrorProps(id('per-day'), errors.feedingsPerDay)}
          />
          <FieldError id={id('per-day')}>{errors.feedingsPerDay}</FieldError>
        </div>
        <div className="grid gap-2">
          <Label htmlFor={id('portion')}>Usual portion</Label>
          <div className="flex gap-2">
            <Input
              type="number"
              inputMode="decimal"
              min={0.01}
              max={PORTION_MAX}
              step="any"
              value={values.portionAmount}
              onChange={(event) => onChange({ portionAmount: event.target.value })}
              placeholder={parsedPortion ? String(parsedPortion.amount) : '1'}
              className="min-w-0"
              {...fieldErrorProps(id('portion'), errors.portionAmount)}
            />
            <Select value={values.portionUnit} onValueChange={(unit) => onChange({ portionUnit: unit as PortionUnit })}>
              <SelectTrigger className="w-28 shrink-0" aria-label="Portion unit">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {PORTION_UNITS.map((unit) => (
                  <SelectItem key={unit} value={unit}>{UNIT_LABELS[unit]}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <FieldError id={id('portion')}>{errors.portionAmount}</FieldError>
        </div>
      </div>
      <p className="-mt-2 text-xs text-muted-foreground">
        Without meal times: used for one-tap feeding and the daily feeding ring. Leave blank to read them from the schedule.
      </p>
      </>
      )}

      <div className="grid gap-2">
        <Label htmlFor={id('weight-unit')}>Weight unit</Label>
        <Select value={values.weightUnit} onValueChange={(unit) => onChange({ weightUnit: unit as WeightUnit })}>
          <SelectTrigger id={id('weight-unit')} className="w-28">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {WEIGHT_UNITS.map((unit) => (
              <SelectItem key={unit} value={unit}>{WEIGHT_UNIT_LABELS[unit]}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <p className="text-xs text-muted-foreground">Weights show in this unit; entries logged in the other unit are converted.</p>
      </div>

      <fieldset className="grid gap-3 rounded-lg border p-3">
        <legend className="px-1 text-sm font-medium">Vet (optional)</legend>
        <div className="grid gap-2">
          <Label htmlFor={id('vet-clinic')}>Clinic</Label>
          <Input
            value={values.vetClinic}
            maxLength={VET_TEXT_MAX + 10}
            onChange={(event) => onChange({ vetClinic: event.target.value })}
            placeholder="Riverside Animal Hospital"
            autoComplete="off"
            {...fieldErrorProps(id('vet-clinic'), draftErrors.vet.vetClinic)}
          />
          <FieldError id={id('vet-clinic')}>{draftErrors.vet.vetClinic}</FieldError>
        </div>
        <div className="grid gap-2">
          <Label htmlFor={id('vet-name')}>Veterinarian</Label>
          <Input
            value={values.vetName}
            maxLength={VET_TEXT_MAX + 10}
            onChange={(event) => onChange({ vetName: event.target.value })}
            placeholder="Dr. Rivera"
            autoComplete="off"
            {...fieldErrorProps(id('vet-name'), draftErrors.vet.vetName)}
          />
          <FieldError id={id('vet-name')}>{draftErrors.vet.vetName}</FieldError>
        </div>
        <div className="grid gap-2">
          <Label htmlFor={id('vet-phone')}>Phone</Label>
          <Input
            type="tel"
            inputMode="tel"
            value={values.vetPhone}
            maxLength={VET_PHONE_MAX + 10}
            onChange={(event) => onChange({ vetPhone: event.target.value })}
            placeholder="(512) 555-0134"
            autoComplete="off"
            {...fieldErrorProps(id('vet-phone'), draftErrors.vet.vetPhone)}
          />
          <FieldError id={id('vet-phone')}>{draftErrors.vet.vetPhone}</FieldError>
        </div>
      </fieldset>
    </div>
  );
}

/**
 * Firestore fields for a pet from the form (optional numbers only when set).
 * `previous` is the stored pet when editing: an unchanged type keeps its photo
 * hint, so legacy species art survives a save (PE-8a).
 */
export function petFieldsFromForm(values: PetFormState, previous?: Pick<PetProfile, 'type' | 'dataAiHint'> | null) {
  const perDay = values.feedingsPerDay.trim() ? Number(values.feedingsPerDay) : null;
  const amount = values.portionAmount.trim() ? Number(values.portionAmount) : null;
  // With meal times the plan sets the count and portion (confirmMealPlan); the hidden legacy inputs are ignored.
  const slots: MealSlot[] | null = values.meals.length > 0 ? slotsFromDraft(values.meals) : null;
  return {
    name: values.name.trim(),
    type: values.type,
    dataAiHint: speciesHintFor(values.type, previous),
    foodSchedule: values.foodSchedule.trim(),
    feedingsPerDay: slots ? null : perDay,
    portionAmount: slots ? null : amount,
    portionUnit: !slots && amount ? values.portionUnit : null,
    slots,
    ...vetFields(values),
    weightUnit: values.weightUnit,
  };
}

export type PetFields = ReturnType<typeof petFieldsFromForm>;

/** Focus the first invalid field (validation rule: focus moves to the first problem). */
export function focusFirstError(idPrefix: string, draft: PetDraftErrors) {
  const errors = draft.fields;
  const order: [keyof PetFormErrors, string][] = [
    ['name', 'name'],
    ['foodSchedule', 'schedule'],
  ];
  const first = order.find(([key]) => errors[key]);
  if (first) {
    document.getElementById(`${idPrefix}-${first[1]}`)?.focus();
    return;
  }
  const fields: (keyof MealSlotErrors)[] = ['name', 'time', 'amount', 'offDays'];
  for (const [index, row] of draft.meals.entries()) {
    const field = fields.find((key) => row[key]);
    if (field) {
      // Day toggles have no single input: focus the row's first toggle.
      const target = document.getElementById(mealFieldId(idPrefix, index, field));
      (field === 'offDays' ? target?.parentElement?.querySelector<HTMLElement>('button') : target)?.focus();
      return;
    }
  }
  if (draft.plan) {
    document.querySelector<HTMLElement>(`[data-testid="meal-plan-add"]`)?.focus();
    return;
  }
  const legacy: [keyof PetFormErrors, string][] = [
    ['feedingsPerDay', 'per-day'],
    ['portionAmount', 'portion'],
  ];
  const next = legacy.find(([key]) => errors[key]);
  if (next) {
    document.getElementById(`${idPrefix}-${next[1]}`)?.focus();
    return;
  }
  const vet = (['vetClinic', 'vetName', 'vetPhone'] as const).find((key) => draft.vet[key]);
  const vetIds = { vetClinic: 'vet-clinic', vetName: 'vet-name', vetPhone: 'vet-phone' } as const;
  if (vet) document.getElementById(`${idPrefix}-${vetIds[vet]}`)?.focus();
}
