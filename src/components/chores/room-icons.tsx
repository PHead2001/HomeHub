import { Armchair, Baby, Bath, BedDouble, Bike, Car, Cat, Dog, Gamepad2, Hammer, Home, Microwave, Paintbrush, Refrigerator, Sofa, TreeDeciduous, Tv, Utensils, Warehouse, WashingMachine } from 'lucide-react';
import type { LucideIcon, LucideProps } from 'lucide-react';

export const roomIcons = ['Home', 'BedDouble', 'Bath', 'Sofa', 'Utensils', 'Microwave', 'Refrigerator', 'WashingMachine', 'Car', 'Bike', 'TreeDeciduous', 'Warehouse', 'Armchair', 'Tv', 'Gamepad2', 'Baby', 'Dog', 'Cat', 'Hammer', 'Paintbrush'];

const registry: Partial<Record<string, LucideIcon>> = {
  Armchair, Baby, Bath, BedDouble, Bike, Car, Cat, Dog, Gamepad2, Hammer, Home, Microwave, Paintbrush, Refrigerator, Sofa, TreeDeciduous, Tv, Utensils, Warehouse, WashingMachine,
};

export function RoomIcon({ name, ...props }: { name: string } & LucideProps) {
  const Icon = registry[name] ?? Home;
  return <Icon aria-hidden {...props} />;
}
