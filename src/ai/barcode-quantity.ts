import type { PantryItemUnit } from '@/lib/types';

export type ParsedPackageQuantity = {
  quantity: number;
  unit: PantryItemUnit;
};

const unitAliases: Record<string, PantryItemUnit> = {
  g: 'g',
  gram: 'g',
  grams: 'g',
  kg: 'kg',
  kilogram: 'kg',
  kilograms: 'kg',
  oz: 'oz',
  ounce: 'oz',
  ounces: 'oz',
  lb: 'lbs',
  lbs: 'lbs',
  pound: 'lbs',
  pounds: 'lbs',
  ml: 'ml',
  milliliter: 'ml',
  milliliters: 'ml',
  l: 'L',
  liter: 'L',
  liters: 'L',
  'fl oz': 'fl oz',
  'fluid ounce': 'fl oz',
  'fluid ounces': 'fl oz',
  item: 'items',
  items: 'items',
  egg: 'items',
  eggs: 'items',
  can: 'cans',
  cans: 'cans',
  bottle: 'bottles',
  bottles: 'bottles',
  piece: 'pieces',
  pieces: 'pieces',
  slice: 'slices',
  slices: 'slices',
};

const normalizeUnit = (value: string) => unitAliases[value.trim().toLowerCase().replace(/\s+/g, ' ')];

export const parseSimplePackageQuantity = (value?: string | null): ParsedPackageQuantity | null => {
  if (!value) return null;
  const match = value.trim().match(/^(\d+(?:[.,]\d+)?)\s*(fl\s*oz|fluid\s+ounces?|kilograms?|kg|grams?|g|ounces?|oz|pounds?|lbs?|milliliters?|ml|liters?|l|items?|eggs?|cans?|bottles?|pieces?|slices?)$/i);
  if (!match) return null;
  const quantity = Number(match[1].replace(',', '.'));
  const unit = normalizeUnit(match[2]);
  if (!Number.isFinite(quantity) || quantity <= 0 || !unit) return null;
  return { quantity, unit };
};

export const parseOpenFoodFactsQuantity = ({
  quantityText,
  normalizedQuantity,
  normalizedUnit,
}: {
  quantityText?: string | null;
  normalizedQuantity?: number | string | null;
  normalizedUnit?: string | null;
}): ParsedPackageQuantity | null => {
  const displayed = parseSimplePackageQuantity(quantityText);
  if (displayed) return displayed;

  const quantity = typeof normalizedQuantity === 'number'
    ? normalizedQuantity
    : Number(String(normalizedQuantity || '').replace(',', '.'));
  const unit = normalizeUnit(normalizedUnit || '');
  if (!Number.isFinite(quantity) || quantity <= 0 || !unit) return null;
  return { quantity, unit };
};
