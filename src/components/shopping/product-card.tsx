'use client';

import { useState } from 'react';
import Image from 'next/image';
import { format } from 'date-fns';
import { Edit, Package, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import type { BarcodeLibraryItem } from '@/lib/types';

function formatAdded(createdAt: string) {
  const date = new Date(createdAt);
  return Number.isNaN(date.getTime()) ? null : format(date, 'PP');
}

/**
 * A photo-first product card for the Barcode Library (H30): the product photo
 * sits on a soft, blurred copy of itself that also runs behind the title. Items
 * without a photo (or whose photo fails to load) get a package placeholder with
 * the product's initial, so the grid never shows an empty slot.
 */
export function ProductCard({
  item,
  onEdit,
  onDelete,
}: {
  item: BarcodeLibraryItem;
  onEdit?: () => void;
  onDelete?: () => void;
}) {
  const [failed, setFailed] = useState(false);
  const photo = item.imageUrl && !failed ? item.imageUrl : null;
  const added = formatAdded(item.createdAt);
  const initial = item.name.trim().charAt(0).toUpperCase() || '?';

  return (
    <article className="glow-card flex flex-col overflow-hidden rounded-xl border bg-card text-card-foreground shadow-raised" aria-label={item.name}>
      <div className="relative aspect-[4/3] overflow-hidden bg-muted">
        {photo ? (
          <>
            {/* Blurred backdrop: the same photo, scaled and softened. Decorative. */}
            <Image src={photo} alt="" aria-hidden fill unoptimized sizes="320px" className="scale-125 object-cover opacity-60 blur-2xl" />
            <Image
              src={photo}
              alt={`Product image for ${item.name}`}
              fill
              unoptimized
              sizes="(max-width: 640px) 50vw, 240px"
              className="object-contain p-3 drop-shadow-md"
              onError={() => setFailed(true)}
            />
          </>
        ) : (
          <div role="img" aria-label={`No product image for ${item.name}`} className="flex h-full w-full flex-col items-center justify-center gap-1 bg-gradient-to-br from-primary/15 to-muted text-muted-foreground">
            <Package className="h-10 w-10" aria-hidden />
            <span className="font-headline text-2xl font-semibold text-foreground/80" aria-hidden>{initial}</span>
          </div>
        )}
      </div>
      <div className="relative isolate flex flex-1 flex-col gap-1 overflow-hidden p-3">
        {photo && (
          <Image src={photo} alt="" aria-hidden fill unoptimized sizes="320px" className="-z-10 scale-150 object-cover opacity-15 blur-3xl" />
        )}
        <h2 className="line-clamp-2 break-words font-medium leading-snug">{item.name}</h2>
        <p className="font-mono text-xs text-muted-foreground">{item.id}</p>
        {added && <p className="text-xs text-muted-foreground">Added {added}</p>}
        {(onEdit || onDelete) && (
          <div className="mt-auto flex justify-end gap-1 pt-2">
            {onEdit && (
              <Button variant="ghost" size="icon" className="h-8 w-8" aria-label={`Edit ${item.name}`} onClick={onEdit}>
                <Edit className="h-4 w-4" aria-hidden />
              </Button>
            )}
            {onDelete && (
              <Button variant="ghost" size="icon" className="h-8 w-8" aria-label={`Delete ${item.name}`} onClick={onDelete}>
                <Trash2 className="h-4 w-4" aria-hidden />
              </Button>
            )}
          </div>
        )}
      </div>
    </article>
  );
}
