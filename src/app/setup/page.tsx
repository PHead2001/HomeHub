import { notFound } from 'next/navigation';
import { SetupScreen } from '@/components/devices/setup-screen';

// "Set up a wall tablet" (docs/modules/devices/README.md). Ships dark: without the
// public devices flag the route does not exist.
export default function SetupPage() {
  if (process.env.NEXT_PUBLIC_HOMEHUB_DEVICES !== 'true') notFound();
  return <SetupScreen />;
}
