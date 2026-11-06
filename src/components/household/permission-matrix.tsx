'use client';

import * as React from 'react';
import { motion } from 'motion/react';
import { Lock } from 'lucide-react';
import { useReducedMotion } from '@/hooks/use-reduced-motion';
import { DURATION, EASE } from '@/lib/motion';
import { permissionGroups, permissionLabels } from '@/lib/permissions';
import type { HouseholdPermission } from '@/lib/types';
import { cn } from '@/lib/utils';

export type MatrixColumn = {
  id: string;
  /** Column heading (role or member name). */
  label: string;
  /** Optional element shown above the label (avatar, crown). */
  adornment?: React.ReactNode;
  values: Record<HouseholdPermission, boolean>;
  /** Highlight this column (e.g. the viewer's own role). */
  highlight?: boolean;
  /** Present when the column can be edited. */
  editable?: {
    onToggle: (permission: HouseholdPermission) => void;
    /** Cells that cannot change, with the reason read to assistive tech. */
    locked?: Partial<Record<HouseholdPermission, string>>;
    /** Cells that differ from the default (marked with a dot). */
    changed?: ReadonlySet<HouseholdPermission>;
    disabled?: boolean;
  };
};

/**
 * Checkmark that draws itself in when turned on (≤150 ms micro-feedback budget)
 * and fades out when turned off. The first render shows the end state; under
 * reduced motion every change is instant.
 */
function DrawnCheck({ checked, reduced }: { checked: boolean; reduced: boolean }) {
  const transition = reduced ? { duration: 0 } : { duration: DURATION.micro, ease: EASE.standard };
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false" className="h-3.5 w-3.5">
      <motion.path
        d="M3.5 8.5l3 3 6-7"
        fill="none"
        stroke="currentColor"
        strokeWidth={2.25}
        strokeLinecap="round"
        strokeLinejoin="round"
        initial={false}
        animate={{ pathLength: checked ? 1 : 0, opacity: checked ? 1 : 0 }}
        transition={transition}
      />
    </svg>
  );
}

function Cell({
  checked,
  editable,
  locked,
  changed,
  label,
  reduced,
  onToggle,
  disabled,
}: {
  checked: boolean;
  editable: boolean;
  locked?: string;
  changed?: boolean;
  label: string;
  reduced: boolean;
  onToggle?: () => void;
  disabled?: boolean;
}) {
  const box = cn(
    'relative flex h-6 w-6 items-center justify-center rounded-md border transition-ui',
    checked ? 'border-primary bg-primary text-primary-foreground' : 'border-border bg-background text-transparent',
  );
  const dot = changed ? (
    <span aria-hidden className="absolute -right-1 -top-1 h-2 w-2 rounded-full bg-warning ring-2 ring-card" />
  ) : null;

  if (editable && !locked) {
    return (
      <button
        type="button"
        role="checkbox"
        aria-checked={checked}
        aria-label={label}
        disabled={disabled}
        onClick={onToggle}
        className="group inline-flex h-10 w-10 items-center justify-center rounded-md disabled:cursor-not-allowed disabled:opacity-50 [@media(hover:hover)_and_(pointer:fine)]:hover:bg-accent"
        data-matrix-cell
      >
        <span className={box}>
          <DrawnCheck checked={checked} reduced={reduced} />
          {dot}
        </span>
      </button>
    );
  }

  return (
    <span className="inline-flex h-10 w-10 items-center justify-center" title={locked}>
      {locked ? (
        <Lock aria-hidden className="h-3.5 w-3.5 text-muted-foreground" />
      ) : (
        <span className={cn(box, !checked && 'border-border-subtle bg-transparent')}>
          <DrawnCheck checked={checked} reduced={reduced} />
        </span>
      )}
      <span className="sr-only">{locked ? `${label}: ${locked}` : `${label}: ${checked ? 'allowed' : 'not allowed'}`}</span>
    </span>
  );
}

/**
 * Permissions as rows (grouped by module) and roles or members as columns (H25).
 * Read-only columns show the defaults; an editable column turns each cell into a
 * real checkbox button (Tab to move, Space/Enter to toggle). Only the table
 * scrolls sideways on narrow screens, never the page.
 */
export function PermissionMatrix({
  columns,
  caption,
  className,
}: {
  columns: readonly MatrixColumn[];
  caption: string;
  className?: string;
}) {
  const reduced = useReducedMotion();
  return (
    <div className={cn('overflow-x-auto rounded-lg border', className)} data-permission-matrix>
      <table className="w-full min-w-max border-collapse text-sm">
        <caption className="sr-only">{caption}</caption>
        <thead>
          <tr className="border-b bg-muted/40">
            <th scope="col" className="sticky left-0 z-10 bg-card px-3 py-2 text-left font-medium text-muted-foreground">
              Permission
            </th>
            {columns.map((column) => (
              <th
                key={column.id}
                scope="col"
                className={cn(
                  'min-w-[4.5rem] px-2 py-2 text-center align-bottom font-semibold',
                  column.highlight && 'bg-primary/10',
                )}
              >
                <span className="flex flex-col items-center gap-1">
                  {column.adornment}
                  <span className="max-w-[7rem] break-words leading-tight">{column.label}</span>
                </span>
              </th>
            ))}
          </tr>
        </thead>
        {permissionGroups.map((group) => (
          <tbody key={group.title}>
            <tr>
              <th
                scope="colgroup"
                colSpan={columns.length + 1}
                className="sticky left-0 bg-card px-3 pb-1 pt-4 text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground"
              >
                {group.title}
              </th>
            </tr>
            {group.permissions.map((permission) => (
              <tr key={permission} className="border-t border-border-subtle">
                <th scope="row" className="sticky left-0 z-10 bg-card px-3 py-0 text-left font-normal">
                  {permissionLabels[permission]}
                </th>
                {columns.map((column) => (
                  <td key={column.id} className={cn('px-2 py-0 text-center', column.highlight && 'bg-primary/10')}>
                    <Cell
                      checked={Boolean(column.values[permission])}
                      editable={Boolean(column.editable)}
                      disabled={column.editable?.disabled}
                      locked={column.editable?.locked?.[permission]}
                      changed={column.editable?.changed?.has(permission)}
                      label={`${permissionLabels[permission]} for ${column.label}`}
                      reduced={reduced}
                      onToggle={column.editable ? () => column.editable!.onToggle(permission) : undefined}
                    />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        ))}
      </table>
    </div>
  );
}
