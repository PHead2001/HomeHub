'use client';

import { Suspense } from "react";
import { useAuth } from "@/hooks/use-auth";
import { useSessionKnown } from '@/hooks/use-session-known';
import Loading from './loading';
import { ShoppingCenterClient } from "@/components/shopping-center-client";
import { EmptyState } from "@/components/empty-state";
import { Button } from "@/components/ui/button";
import Link from "next/link";
import { ScanBarcode } from "lucide-react";
import { SignInPrompt } from '@/components/profile/sign-in-prompt';
import { Skeleton } from '@/components/ui/skeleton';
import { ShoppingCenterSkeleton } from '@/components/shopping/shopping-skeletons';

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
            <div className="mb-8 flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
                <div className="w-full min-w-0">
                    <h1 className="w-full font-headline text-3xl font-bold tracking-tight">Shopping Center</h1>
                    <p className="text-muted-foreground">Lists in the order you walk the store, and a pantry that shows what is on the shelves.</p>
                </div>
                {pending && <Skeleton className="h-10 w-full shrink-0 sm:w-36" aria-hidden />}
                {currentUser && canView && (
                    <Button asChild variant="outline" className="w-full sm:w-auto">
                        <Link href="/library">
                            <ScanBarcode className="mr-2" aria-hidden /> Barcode Library
                        </Link>
                    </Button>
                )}
            </div>

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
