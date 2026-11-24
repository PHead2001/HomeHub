'use client';

import { useId } from 'react';
import { CheckCircle2, CircleAlert } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { WarrantyClaimChecklist as Checklist } from '@/lib/maintenance/warranty-claim';

/**
 * Warranty-claim checklist (MA-33c): what a claim needs, what HomeHub already has
 * and what is missing, for one asset. Build `checklist` with
 * `warrantyClaimChecklist(asset, attachments, today)`. Static (no motion).
 */
export function WarrantyClaimChecklist({ checklist, className }: { checklist: Checklist; className?: string }) {
  const headingId = useId();
  return (
    <section aria-labelledby={headingId} data-testid="warranty-claim-checklist" className={cn('space-y-3', className)}>
      <div>
        <h3 id={headingId} className="font-headline text-base font-semibold">Warranty claim checklist</h3>
        <p className="text-sm text-muted-foreground">{checklist.summary}</p>
        <p className="text-sm text-muted-foreground">
          {checklist.missing === 0 ? 'HomeHub has everything a claim usually asks for.' : `${checklist.missing} of ${checklist.items.length} still missing.`}
        </p>
      </div>
      <ul className="space-y-1">
        {checklist.items.map((item) => (
          <li key={item.key} data-have={item.have ? 'true' : 'false'} className="flex items-start gap-3 rounded-md px-2 py-1.5 text-sm">
            {item.have
              ? <CheckCircle2 aria-hidden className="mt-0.5 h-4 w-4 shrink-0 text-success" />
              : <CircleAlert aria-hidden className="mt-0.5 h-4 w-4 shrink-0 text-warning" />}
            <span className="min-w-0 flex-1">
              <span className="font-medium">{item.label}</span>
              <span className="sr-only">{item.have ? ': have it' : ': missing'}</span>
              {item.have
                ? item.value && <span className="block break-words text-muted-foreground">{item.value}</span>
                : <span className="block text-muted-foreground">Missing. {item.hint}</span>}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}
