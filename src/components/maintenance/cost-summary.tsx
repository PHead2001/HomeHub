import { cn } from '@/lib/utils';
import {
  formatPerMile,
  formatWholeDollars,
  UNDATED,
  withoutCostText,
  type CostSummaryData,
} from '@/lib/maintenance/costs';

/**
 * Cost insights for one asset or vehicle (MA-28): lifetime cost, spend per
 * year, cost per mile (vehicles) and the repair-versus-replace hint. Amounts are
 * whole US dollars (cost per mile in cents); costs are never converted between
 * currencies. Presentational: the numbers come from `costSummary()`.
 */
export function CostSummary({
  summary,
  name,
  className,
}: {
  summary: CostSummaryData;
  /** The asset or vehicle name, for the section's accessible name. */
  name: string;
  className?: string;
}) {
  const { lifetime, years, perMile, repair } = summary;
  const missing = withoutCostText(lifetime.withoutCost);
  const hasCosts = lifetime.counted > 0;

  return (
    <section aria-label={`Costs for ${name}`} className={cn('space-y-3 text-sm', className)}>
      <div>
        <p className="text-muted-foreground">Lifetime cost</p>
        <p className="font-headline text-2xl font-semibold tabular-nums">
          {hasCosts ? formatWholeDollars(lifetime.total) : 'No costs recorded yet'}
        </p>
        {missing && <p className="text-muted-foreground">{missing}</p>}
      </div>

      {years.length > 0 && (
        <div>
          <p className="text-muted-foreground">Spend by year</p>
          <dl className="mt-1 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
            {years.map((entry) => (
              <div key={entry.year} className="contents">
                <dt className={cn(entry.year === UNDATED && 'text-muted-foreground')}>{entry.year}</dt>
                <dd className="text-right tabular-nums">{formatWholeDollars(entry.total)}</dd>
              </div>
            ))}
          </dl>
        </div>
      )}

      {perMile && (
        <div>
          <p className="text-muted-foreground">Cost per mile</p>
          <p className="tabular-nums">{perMile.kind === 'ok' ? formatPerMile(perMile.perMile) : perMile.text}</p>
        </div>
      )}

      {repair.kind === 'over' && <p className="rounded-md border border-warning/50 bg-warning/10 p-2">{repair.text}</p>}
      {repair.kind === 'no-price' && <p className="text-muted-foreground">{repair.text}</p>}
    </section>
  );
}
