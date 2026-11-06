import {
  Beer, Car, Cat, ClipboardList, Coffee, Dog, Drama, Dumbbell, Gift, HeartPulse, Home, PawPrint, Pizza, Plane,
  Popcorn, School, Shirt, ShoppingCart, Stethoscope, TreePalm, Wrench,
} from 'lucide-react';
import { createElement } from 'react';
import type { LucideIcon, LucideProps } from 'lucide-react';
import type { ShoppingList } from '@/lib/types';
import { resolveListIconName } from '@/lib/shopping/list-style';

/** Icons a member can pick for a list, in picker order. */
export const PRESET_LIST_ICONS = [
  'ShoppingCart', 'Car', 'Wrench', 'PawPrint', 'Home', 'Gift', 'Beer', 'Shirt', 'Drama', 'Popcorn',
  'Dumbbell', 'Plane', 'HeartPulse', 'Stethoscope', 'School', 'Dog', 'Cat', 'TreePalm', 'Coffee', 'Pizza',
] as const;

/** Readable names for the icon picker's accessible labels. */
export const LIST_ICON_LABELS: Record<string, string> = {
  ShoppingCart: 'cart', Car: 'car', Wrench: 'wrench', PawPrint: 'paw print', Home: 'home', Gift: 'gift', Beer: 'drinks',
  Shirt: 'clothes', Drama: 'theatre', Popcorn: 'snacks', Dumbbell: 'fitness', Plane: 'travel', HeartPulse: 'health',
  Stethoscope: 'medical', School: 'school', Dog: 'dog', Cat: 'cat', TreePalm: 'holiday', Coffee: 'coffee', Pizza: 'food',
  ClipboardList: 'list',
};

const REGISTRY: Record<string, LucideIcon> = {
  Beer, Car, Cat, ClipboardList, Coffee, Dog, Drama, Dumbbell, Gift, HeartPulse, Home, PawPrint, Pizza, Plane,
  Popcorn, School, Shirt, ShoppingCart, Stethoscope, TreePalm, Wrench,
};

export const KNOWN_LIST_ICONS: ReadonlySet<string> = new Set(Object.keys(REGISTRY));

/** Icon component by name (ClipboardList when unknown). */
export function listIconByName(name: string): LucideIcon {
  return REGISTRY[name] ?? ClipboardList;
}

/** The icon for a list; unknown stored names fall back to the list type's icon (D14). */
export function listIcon(list: Pick<ShoppingList, 'icon' | 'type'>): LucideIcon {
  return listIconByName(resolveListIconName(list, KNOWN_LIST_ICONS));
}

/** Renders a list's icon (decorative). */
export function renderListIcon(list: Pick<ShoppingList, 'icon' | 'type'>, props: LucideProps = {}) {
  return createElement(listIcon(list), { 'aria-hidden': true, ...props });
}

/** Renders an icon by name (decorative). */
export function renderListIconByName(name: string, props: LucideProps = {}) {
  return createElement(listIconByName(name), { 'aria-hidden': true, ...props });
}
