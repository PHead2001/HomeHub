'use client';

import { useAuth } from '@/hooks/use-auth';
import { useSessionKnown } from '@/hooks/use-session-known';
import Loading from './loading';
import { HouseholdCalendar } from '@/components/chores/calendar/household-calendar';
import { SignInPrompt } from '@/components/profile/sign-in-prompt';

export default function CalendarPage() {
  const { currentUser } = useAuth();
  const sessionKnown = useSessionKnown();
  // SL-11: the route skeleton, not the sign-in prompt, until Auth has answered.
  if (!currentUser && !sessionKnown) return <Loading />;
  return (
    <div className="container mx-auto px-4 py-8">
      {!currentUser && <SignInPrompt what="see the household calendar" />}
      {currentUser && <HouseholdCalendar />}
    </div>
  );
}
