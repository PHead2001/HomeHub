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
  parseFeedingsPerDay,
  parsePortion,
  type PetFormErrors,
  type PetFormValues,
} from '@/lib/pets/care';
import { PET_SPECIES, PORTION_UNITS, type PetProfile, type PortionUnit } from '@/lib/pets/types';

export type PetFormState = PetFormValues & {
  type: string;
  portionUnit: PortionUnit;
};

export const EMPTY_PET_FORM: PetFormState = {
  name: '',
  type: 'Dog',
  foodSchedule: '',
  feedingsPerDay: '',
  portionAmount: '',
  portionUnit: 'Cups',
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
  };
}

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
  errors: PetFormErrors;
  onChange: (patch: Partial<PetFormState>) => void;
  onPhotoChange: (file: File | null) => void;
  existingPhotoUrl?: string;
  nameDisabled?: boolean;
};

/** Shared fields for the add and edit pet dialogs, with inline field errors. */
export function PetFormFields({ idPrefix, values, errors, onChange, onPhotoChange, existingPhotoUrl, nameDisabled }: PetFormFieldsProps) {
  const id = (field: string) => `${idPrefix}-${field}`;
  const parsedPerDay = parseFeedingsPerDay(values.foodSchedule);
  const parsedPortion = parsePortion(values.foodSchedule);

  return (
    <div className="grid gap-4 py-2">
      <div className="grid gap-2">
        <Label>Photo</Label>
        {/* The shared uploader's Remove button has no `type`, so inside the dialog form it
            would submit. Cancel only the submit default; its own click handler still runs. */}
        <div onClick={preventImplicitSubmit}>
          <ImageUpload
            onFileChange={onPhotoChange}
            existingImageUrl={existingPhotoUrl}
            previewAlt={values.name ? `Photo preview for ${values.name}` : 'New pet photo preview'}
          />
        </div>
        <p className="text-xs text-muted-foreground">Optional. Without a photo, your pet gets an illustrated avatar.</p>
      </div>

      <div className="grid gap-2">
        <Label htmlFor={id('name')}>Name</Label>
        <Input
          value={values.name}
          maxLength={PET_NAME_MAX + 10}
          onChange={(event) => onChange({ name: event.target.value })}
          placeholder="Buddy"
          disabled={nameDisabled}
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
        <Label htmlFor={id('schedule')}>Food schedule</Label>
        <Textarea
          value={values.foodSchedule}
          maxLength={FOOD_SCHEDULE_MAX + 20}
          onChange={(event) => onChange({ foodSchedule: event.target.value })}
          placeholder="e.g. 1.5 cups at 8am and 6pm"
          rows={2}
          {...fieldErrorProps(id('schedule'), errors.foodSchedule)}
        />
        <FieldError id={id('schedule')}>{errors.foodSchedule}</FieldError>
      </div>

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
              min={0.25}
              max={50}
              step={0.25}
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
                  <SelectItem key={unit} value={unit}>{unit}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <FieldError id={id('portion')}>{errors.portionAmount}</FieldError>
        </div>
      </div>
      <p className="-mt-2 text-xs text-muted-foreground">
        Used for one-tap feeding and the daily feeding ring. Leave blank to read them from the schedule.
      </p>
    </div>
  );
}

/** Firestore fields for a pet from the form (optional numbers only when set). */
export function petFieldsFromForm(values: PetFormState) {
  const perDay = values.feedingsPerDay.trim() ? Number(values.feedingsPerDay) : null;
  const amount = values.portionAmount.trim() ? Number(values.portionAmount) : null;
  return {
    name: values.name.trim(),
    type: values.type,
    dataAiHint: values.type.toLowerCase(),
    foodSchedule: values.foodSchedule.trim(),
    feedingsPerDay: perDay,
    portionAmount: amount,
    portionUnit: amount ? values.portionUnit : null,
  };
}

export type PetFields = ReturnType<typeof petFieldsFromForm>;

/** Focus the first invalid field (validation rule: focus moves to the first problem). */
export function focusFirstError(idPrefix: string, errors: PetFormErrors) {
  const order: [keyof PetFormErrors, string][] = [
    ['name', 'name'],
    ['foodSchedule', 'schedule'],
    ['feedingsPerDay', 'per-day'],
    ['portionAmount', 'portion'],
  ];
  const first = order.find(([key]) => errors[key]);
  if (first) document.getElementById(`${idPrefix}-${first[1]}`)?.focus();
}
