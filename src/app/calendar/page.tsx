'use client';

import { useAuth } from '@/hooks/use-auth';
import { HouseholdCalendar } from '@/components/chores/calendar/household-calendar';

export default function CalendarPage() {
  const { currentUser } = useAuth();
  return (
    <div className="container mx-auto px-4 py-8">
      {!currentUser && <p className="py-8">Please log in to see the household calendar.</p>}
      {currentUser && <HouseholdCalendar />}
    </div>
  );
}
