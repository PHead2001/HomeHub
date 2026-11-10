'use client';

import { Suspense } from 'react';
import { useAuth } from "@/hooks/use-auth";
import { useSessionKnown } from '@/hooks/use-session-known';
import Loading from './loading';
import { ChoreChartClient } from "@/components/chore-chart-client";
import { SignInPrompt } from '@/components/profile/sign-in-prompt';

export default function ChoresPage() {
    const { currentUser } = useAuth();
    const sessionKnown = useSessionKnown();
    // SL-11: the route skeleton, not the sign-in prompt, until Auth has answered.
    if (!currentUser && !sessionKnown) return <Loading />;
    return (
        <div className="container mx-auto px-4 py-8">
            {!currentUser && <SignInPrompt what="manage your chores" />}
            {/* ChoreChartClient reads useSearchParams (the `?room=` filter). */}
            {currentUser && (
                <Suspense fallback={null}>
                    <ChoreChartClient />
                </Suspense>
            )}
        </div>
    );
}
