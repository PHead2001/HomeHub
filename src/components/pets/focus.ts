'use client';

/**
 * Focus return for Pets dialogs that open without a trigger of their own (from a
 * menu item, or programmatically), PE-20e: Radix would return focus to the menu
 * item, which is gone by then, so focus would fall to the page. Instead it goes
 * to the pet's actions button, or, when the pet is gone (deleted), to the page
 * heading (`data-pets-heading`, focusable with tabIndex -1).
 */
export function focusPetActions(petId: string | null | undefined): void {
  if (typeof document === 'undefined') return;
  const escaped = petId && typeof CSS !== 'undefined' ? CSS.escape(petId) : petId;
  const actions = escaped ? document.querySelector<HTMLElement>(`[data-pet-actions="${escaped}"]`) : null;
  // The heading shown at this width (the pet page has a phone and a wide one, PE-13c).
  const headings = [...document.querySelectorAll<HTMLElement>('[data-pets-heading]')];
  const heading = headings.find((element) => element.getClientRects().length > 0) ?? headings[0];
  (actions ?? heading)?.focus();
}

/** For a dialog's `onCloseAutoFocus`: stop Radix's own return and focus the pet's actions instead. */
export function returnFocusToPet(petId: string | null | undefined) {
  return (event: Event) => {
    event.preventDefault();
    focusPetActions(petId);
  };
}
