'use client';

import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { brandMark, matchBrand, type BrandEntry } from '@/lib/maintenance/brands';
import { cn } from '@/lib/utils';

// The artwork chunk is loaded once, on first use, and shared by every logo.
let marksPromise: Promise<Record<string, string>> | null = null;
let marksCache: Record<string, string> | null = null;
const loadMarks = () => {
  marksPromise ??= import('./brand-marks')
    .then((module) => {
      marksCache = module.BRAND_MARKS;
      return marksCache;
    })
    .catch(() => {
      marksPromise = null;
      return {};
    });
  return marksPromise;
};

function useBrandPath(brand: BrandEntry | null) {
  // undefined while the artwork chunk loads, so a badge never flashes before a logo.
  const [path, setPath] = useState<string | null | undefined>(() => (marksCache ? (brand && marksCache[brand.id]) || null : undefined));
  useEffect(() => {
    if (!brand) return;
    let live = true;
    void loadMarks().then((marks) => {
      if (live) setPath(marks[brand.id] ?? null);
    });
    return () => {
      live = false;
    };
  }, [brand]);
  return path;
}

const SIZES = {
  sm: { box: 'h-6 min-w-6', svg: 'h-5 w-5', text: 'text-[0.625rem]' },
  md: { box: 'h-8 min-w-8', svg: 'h-7 w-7', text: 'text-xs' },
  lg: { box: 'h-12 min-w-12', svg: 'h-10 w-10', text: 'text-sm' },
} as const;

/**
 * A brand's mark (H30), drawn in `currentColor` so it follows every theme.
 * Brands with Simple Icons artwork show it; others show a monogram badge in the
 * app's type. With no recognised brand it renders `fallback` (the category
 * icon). `decorative` hides it from assistive tech when the brand name is
 * already shown as text; otherwise it is an image named after the brand.
 */
export function BrandLogo({
  brand: value,
  size = 'md',
  decorative = false,
  fallback = null,
  className,
}: {
  brand?: string | null;
  size?: keyof typeof SIZES;
  decorative?: boolean;
  fallback?: ReactNode;
  className?: string;
}) {
  const brand = useMemo(() => matchBrand(value), [value]);
  const path = useBrandPath(brand);
  if (!brand) return <>{fallback}</>;
  const sizing = SIZES[size];
  const a11y = decorative ? { 'aria-hidden': true as const } : { role: 'img' as const, 'aria-label': brand.name };

  if (path === undefined) {
    return <span {...a11y} data-brand={brand.id} className={cn('inline-block shrink-0', sizing.box, className)} />;
  }
  if (path) {
    return (
      <span {...a11y} data-brand={brand.id} data-brand-kind="logo" className={cn('inline-grid shrink-0 place-items-center', sizing.box, className)}>
        <svg viewBox="0 0 24 24" className={sizing.svg} fill="currentColor" aria-hidden focusable="false">
          <path d={path} />
        </svg>
      </span>
    );
  }
  return (
    <span
      {...a11y}
      data-brand={brand.id}
      data-brand-kind="badge"
      className={cn(
        'inline-grid shrink-0 place-items-center rounded-md border-2 border-current px-1 font-headline font-bold leading-none tracking-tight',
        sizing.box,
        sizing.text,
        className,
      )}
    >
      <span aria-hidden>{brandMark(brand)}</span>
    </span>
  );
}
