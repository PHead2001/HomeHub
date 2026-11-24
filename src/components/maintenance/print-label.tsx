'use client';

import { useEffect, useMemo, useRef } from 'react';
import { Printer } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { qrSvg } from '@/lib/maintenance/qr-label';

const PRINT_ATTR = 'data-print-label';
const SHEET_ATTR = 'data-print-label-sheet';

/**
 * Print rules, active only while a label is being printed (`<html data-print-label>`):
 * every child of <body> except the print sheet is removed from the layout, so the
 * label prints alone on one page wherever it sits (a dialog, a scrolled panel),
 * black on white in every theme. The sheet itself never shows on screen.
 */
export const PRINT_LABEL_CSS = `[${SHEET_ATTR}] { display: none; }
@media print {
  html[${PRINT_ATTR}], html[${PRINT_ATTR}] body { background: white !important; height: auto !important; min-height: 0 !important; overflow: visible !important; }
  html[${PRINT_ATTR}] body > :not([${SHEET_ATTR}]) { display: none !important; }
  html[${PRINT_ATTR}] [${SHEET_ATTR}] { display: block !important; padding: 0.5in 0; }
  html[${PRINT_ATTR}] [${SHEET_ATTR}] * { color: black !important; border-color: black !important; box-shadow: none !important; }
  html[${PRINT_ATTR}] [${SHEET_ATTR}] figure { background: white !important; margin: 0 auto; break-inside: avoid; }
}`;

/**
 * Copies the label into a sheet at the end of <body>, marks <html> for the print
 * rules and returns the cleanup that undoes both. Kept separate so the print
 * layout can be checked in a browser.
 */
export function beginLabelPrint(figure: HTMLElement): () => void {
  const doc = figure.ownerDocument;
  const sheet = doc.createElement('div');
  sheet.setAttribute('data-print-label-sheet', '');
  sheet.appendChild(figure.cloneNode(true));
  doc.body.appendChild(sheet);
  doc.documentElement.setAttribute('data-print-label', '');
  return () => {
    sheet.remove();
    if (!doc.querySelector('[data-print-label-sheet]')) doc.documentElement.removeAttribute('data-print-label');
  };
}

/**
 * A printable label for an asset or vehicle (MA-31): name, location, a QR code
 * of its deep link (`maintenanceDeepLink()`) and "Scan to open in HomeHub".
 * "Print label" prints only the label (see `PRINT_LABEL_CSS`); printing the
 * page any other way is unchanged.
 */
export function PrintLabel({
  name,
  location,
  url,
  className,
}: {
  name: string;
  location?: string | null;
  /** The deep link from `maintenanceDeepLink()`. */
  url: string;
  className?: string;
}) {
  const qr = useMemo(() => qrSvg(url), [url]);
  const figure = useRef<HTMLElement | null>(null);
  const cleanup = useRef<(() => void) | null>(null);

  useEffect(() => () => cleanup.current?.(), []);

  const print = () => {
    if (!figure.current) return;
    cleanup.current?.();
    const done = beginLabelPrint(figure.current);
    const finish = () => {
      window.removeEventListener('afterprint', finish);
      done();
      if (cleanup.current === finish) cleanup.current = null;
    };
    cleanup.current = finish;
    window.addEventListener('afterprint', finish);
    window.print();
  };

  return (
    <div className={cn('space-y-3', className)}>
      {/* Static rules, no record data. */}
      <style dangerouslySetInnerHTML={{ __html: PRINT_LABEL_CSS }} />
      <figure
        ref={figure}
        className="mx-auto flex w-64 max-w-full flex-col items-center gap-2 rounded-md border bg-card p-4 text-center text-card-foreground"
      >
        {/* Dark modules on white in every theme: scanners need the contrast. */}
        <svg
          role="img"
          aria-label={`QR code that opens ${name} in HomeHub`}
          viewBox={`0 0 ${qr.side} ${qr.side}`}
          className="aspect-square w-48 max-w-full rounded-sm bg-white text-black"
          shapeRendering="crispEdges"
        >
          <path d={qr.path} fill="currentColor" />
        </svg>
        <figcaption className="space-y-0.5">
          <p className="font-headline text-base font-semibold">{name}</p>
          {location?.trim() && <p className="text-sm">{location.trim()}</p>}
          <p className="text-xs text-muted-foreground">Scan to open in HomeHub</p>
        </figcaption>
      </figure>
      <div className="flex justify-center">
        <Button type="button" variant="outline" onClick={print}>
          <Printer aria-hidden /> Print label
        </Button>
      </div>
    </div>
  );
}
