import { RouteSkeleton } from '@/components/route-skeletons';
import { PetDetailSkeletonBody } from '@/components/pets/pets-skeleton';

// Pet detail: back button, photo card and info card, then the tabs panel (the page keeps the same skeleton, PE-21g).
export default function Loading() {
  return (
    <RouteSkeleton label="pet details">
      <PetDetailSkeletonBody />
    </RouteSkeleton>
  );
}
