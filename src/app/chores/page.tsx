'use client';

import { Suspense } from 'react';
import { useAuth } from "@/hooks/use-auth";
import { ChoreChartClient } from "@/components/chore-chart-client";
import { SignInPrompt } from '@/components/profile/sign-in-prompt';

export default function ChoresPage() {
    const { currentUser } = useAuth();
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
