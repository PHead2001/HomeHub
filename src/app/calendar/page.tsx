'use client';

import { useAuth } from '@/hooks/use-auth';
import { HouseholdCalendar } from '@/components/chores/calendar/household-calendar';
import { SignInPrompt } from '@/components/profile/sign-in-prompt';

export default function CalendarPage() {
  const { currentUser } = useAuth();
  return (
    <div className="container mx-auto px-4 py-8">
      {!currentUser && <SignInPrompt what="see the household calendar" />}
      {currentUser && <HouseholdCalendar />}
    </div>
  );
}
