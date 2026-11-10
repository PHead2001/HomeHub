'use client';

import { useAuth } from "@/hooks/use-auth";
import { useSessionKnown } from '@/hooks/use-session-known';
import Loading from './loading';
import { ProfileClient } from "@/components/profile-client";
import { SignInPrompt } from "@/components/profile/sign-in-prompt";
import { CardSkeleton } from "@/components/route-skeletons";

export default function ProfilePage() {
    const { currentUser, profileConfirmed } = useAuth();
    const sessionKnown = useSessionKnown();
    // SL-11: the route skeleton, not the sign-in prompt, until Auth has answered.
    if (!currentUser && !sessionKnown) return <Loading />;
    return (
        <div className="container mx-auto px-4 py-8">
            <div className="mb-8">
                <h1 className="font-headline text-3xl font-bold tracking-tight">Your Profile</h1>
                <p className="text-muted-foreground">Manage your personal information and settings.</p>
            </div>

            {/* The forms take their starting values from the profile once, so they wait for the
                server-confirmed copy: a provisional cached one may predate an edit made on
                another device, and saving would write it back. */}
            {!currentUser ? (
                <SignInPrompt what="see your profile" />
            ) : profileConfirmed ? (
                <ProfileClient />
            ) : (
                <div role="status" aria-busy="true" className="mx-auto grid max-w-6xl grid-cols-1 gap-8 md:grid-cols-3">
                    <span className="sr-only">Loading your profile…</span>
                    <div aria-hidden className="space-y-8 md:col-span-2">
                        <CardSkeleton lines={6} className="h-96" />
                    </div>
                    <div aria-hidden className="space-y-8 md:col-span-1">
                        <CardSkeleton lines={5} className="h-96" />
                        <CardSkeleton lines={3} className="h-56" />
                    </div>
                </div>
            )}
        </div>
    );
}
