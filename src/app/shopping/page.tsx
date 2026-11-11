'use client';

import { Suspense } from "react";
import { useAuth } from "@/hooks/use-auth";
import { useSessionKnown } from '@/hooks/use-session-known';
import Loading from './loading';
import { ShoppingCenterClient } from "@/components/shopping-center-client";
import { EmptyState } from "@/components/empty-state";
import { SignInPrompt } from '@/components/profile/sign-in-prompt';
import { ShoppingCenterSkeleton } from '@/components/shopping/shopping-skeletons';
import { ShoppingPageHeader } from '@/components/shopping/shopping-page-header';

export default function ShoppingPage() {
    const { currentUser, currentMember, permissions, householdLoading } = useAuth();
    const canView = Boolean(permissions['shopping.view']);
    // Permissions are known once the member record has loaded.
    const denied = Boolean(currentUser && !householdLoading && currentMember && !canView);
    const sessionKnown = useSessionKnown();
    // SL-11: the route skeleton, not the sign-in prompt, until Auth has answered.
    if (!currentUser && !sessionKnown) return <Loading />;
    // Signed in but the member record is still loading: the page keeps drawing the
    // route skeleton's shape (SH-25a), so the header button, tabs and cards never
    // shift between skeleton, blank and content.
    const pending = Boolean(currentUser) && !canView && !denied && householdLoading;
    return (
        <div className="container mx-auto px-4 py-8">
            {/* Collapses to a hidden h1 while a list is open (SH-12a). */}
            <ShoppingPageHeader canView={Boolean(currentUser && canView)} pending={pending} />

            {pending && <ShoppingCenterSkeleton />}

            {!currentUser && <SignInPrompt what="manage your shopping lists and inventory" />}

            {denied && (
                <EmptyState
                    kind="lists"
                    title="Shopping is not shared with you"
                    description="Ask a household admin for shopping access to see the lists and pantry."
                    action={{ label: 'Go home', href: '/' }}
                    className="rounded-xl border border-dashed"
                />
            )}

            {currentUser && canView && (
                // ShoppingCenterClient reads useSearchParams (URL-driven tab and list).
                <Suspense fallback={<ShoppingCenterSkeleton />}>
                    <ShoppingCenterClient />
                </Suspense>
            )}
        </div>
    );
}
