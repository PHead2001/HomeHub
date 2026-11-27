'use client';

import { useAuth } from "@/hooks/use-auth";
import { useSessionKnown } from '@/hooks/use-session-known';
import Loading from './loading';
import { ProfileClient } from "@/components/profile-client";
import { SignInPrompt } from "@/components/profile/sign-in-prompt";
import { CardSkeleton } from "@/components/route-skeletons";
import { InstallAppCard } from "@/components/profile/install-app-card";
import { ProfileLoadError } from "@/components/profile/profile-load-error";

export default function ProfilePage() {
    const { currentUser, profileConfirmed, profileLoadFailed } = useAuth();
    const sessionKnown = useSessionKnown();
    // SL-11: the route skeleton, not the sign-in prompt, until Auth has answered.
    // PR-7: unless the profile read itself failed; that shows an error with Retry.
    if (!currentUser && !sessionKnown && !profileLoadFailed) return <Loading />;
    return (
        <div className="container mx-auto px-4 py-8">
            <div className="mb-8">
                <h1 className="font-headline text-3xl font-bold tracking-tight">Your Profile</h1>
                <p className="text-muted-foreground">Manage your personal information and settings.</p>
            </div>

            {/* SL-19: only while the browser offers to install the app. */}
            {currentUser && <InstallAppCard className="mx-auto mb-8 max-w-6xl" />}

            {/* The forms take their starting values from the profile once, so they wait for the
                server-confirmed copy: a provisional cached one may predate an edit made on
                another device, and saving would write it back. */}
            {profileLoadFailed && !profileConfirmed ? (
                <ProfileLoadError />
            ) : !currentUser ? (
                <SignInPrompt what="see your profile" />
            ) : profileConfirmed ? (
                <ProfileClient />
            ) : (
                <div role="status" aria-busy="true" className="mx-auto flex max-w-6xl flex-wrap gap-8">
                    <span className="sr-only">Loading your profile…</span>
                    {/* Matches the two equal columns of ProfileClient (PR-18). */}
                    <div aria-hidden className="min-w-0 flex-[1_1_24rem] space-y-8">
                        <CardSkeleton lines={6} className="h-96" />
                        <CardSkeleton lines={4} className="h-72" />
                    </div>
                    <div aria-hidden className="min-w-0 flex-[1_1_24rem] space-y-8">
                        <CardSkeleton lines={8} className="h-[36rem]" />
                    </div>
                </div>
            )}
        </div>
    );
}
