'use client';

import { Edit, PencilLine, Trash2 } from 'lucide-react';
import type { HomeAsset, Vehicle } from '@/lib/types';
import { Button } from '@/components/ui/button';
import { presentFields } from '@/lib/maintenance/display';
import { humanizeLabel, optionalCurrency, optionalDate } from './page-model';

type Field = { label: string; value?: string | number | null };

export const assetFields = (asset: HomeAsset): Field[] => [
    { label: 'Status', value: humanizeLabel(asset.status) },
    { label: 'Location', value: asset.location },
    { label: 'Brand', value: asset.brand },
    { label: 'Model', value: asset.model },
    { label: 'Serial Number', value: asset.serialNumber },
    { label: 'Purchase Price', value: optionalCurrency(asset.purchasePrice) },
    { label: 'Purchase Date', value: optionalDate(asset.purchaseDate) },
    { label: 'Warranty Ends', value: optionalDate(asset.warrantyExpiration) },
    { label: 'Warranty Provider', value: asset.warrantyProvider },
];

export const vehicleFields = (vehicle: Vehicle): Field[] => [
    { label: 'Status', value: humanizeLabel(vehicle.status) },
    { label: 'Mileage', value: typeof vehicle.currentMileage === 'number' ? vehicle.currentMileage.toLocaleString() : undefined },
    { label: 'VIN', value: vehicle.vin },
    { label: 'License Plate', value: vehicle.licensePlate },
    { label: 'Insurance', value: vehicle.insuranceProvider },
    { label: 'Purchase Price', value: optionalCurrency(vehicle.purchasePrice) },
    { label: 'Purchase Date', value: optionalDate(vehicle.purchaseDate) },
    { label: 'Registration Expires', value: optionalDate(vehicle.registrationExpiration) },
    { label: 'Inspection Expires', value: optionalDate(vehicle.inspectionExpiration) },
];

export const missingCount = (fields: Field[]) => fields.length - presentFields(fields).length;

/** One action row for a detail panel (D15): Edit and Add details on the left, Delete apart on the right. */
export function DetailActions({
  name,
  kind,
  missing,
  canEdit,
  canDelete,
  onEdit,
  onDelete,
}: {
  name: string;
  kind: 'home asset' | 'vehicle';
  missing: number;
  canEdit: boolean;
  canDelete: boolean;
  onEdit: () => void;
  onDelete: () => void;
}) {
  if (!canEdit && !canDelete) return null;
  return (
    // Fits one row in the 320-420 px detail column; wraps only on very narrow screens.
    <div className="flex flex-wrap items-center gap-x-1 gap-y-2 border-t pt-4">
      {canEdit && (
        <Button aria-label={`Edit ${kind} ${name}`} variant="outline" size="sm" onClick={onEdit}>
          <Edit className="mr-2 h-4 w-4" />
          Edit
        </Button>
      )}
      {canEdit && missing > 0 && (
        <Button variant="ghost" size="sm" onClick={onEdit}>
          <PencilLine className="mr-2 h-4 w-4" />
          Add details
          <span className="sr-only">({missing} empty)</span>
        </Button>
      )}
      {canDelete && (
        <Button
          aria-label={`Delete ${kind} ${name}`}
          variant="ghost"
          size="sm"
          className="ml-auto text-destructive hover:text-destructive"
          onClick={onDelete}
        >
          <Trash2 className="mr-2 h-4 w-4" />
          Delete
        </Button>
      )}
    </div>
  );
}
