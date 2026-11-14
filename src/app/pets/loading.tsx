import { RouteSkeleton } from '@/components/route-skeletons';
import { PetsListSkeletonBody } from '@/components/pets/pets-skeleton';

// Your Pets: the one skeleton the page keeps until the list has loaded (PE-21g).
export default function Loading() {
  return (
    <RouteSkeleton label="pets">
      <PetsListSkeletonBody />
    </RouteSkeleton>
  );
}
