/** Pure helpers for inline field errors; see `FieldError` in src/components/field-error.tsx. */

/** Id of the message element for a field id (`<field>-error`). */
export function fieldErrorId(fieldId: string): string {
  return `${fieldId}-error`;
}

/** ARIA props for the input: marks it invalid and links it to its message. */
export function fieldErrorProps(
  fieldId: string,
  error: unknown,
): { id: string; 'aria-invalid'?: true; 'aria-describedby'?: string } {
  return error ? { id: fieldId, 'aria-invalid': true, 'aria-describedby': fieldErrorId(fieldId) } : { id: fieldId };
}
