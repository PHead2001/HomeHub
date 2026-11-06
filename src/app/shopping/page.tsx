'use client';

import { useAuth } from "@/hooks/use-auth";
import { ShoppingCenterClient } from "@/components/shopping-center-client";
import { EmptyState } from "@/components/empty-state";
import { Button } from "@/components/ui/button";
import Link from "next/link";
import { ScanBarcode } from "lucide-react";

export default function ShoppingPage() {
    const { currentUser, currentMember, permissions, householdLoading } = useAuth();
    const canView = Boolean(permissions['shopping.view']);
    // Permissions are known once the member record has loaded; until then show nothing extra.
    const denied = Boolean(currentUser && !householdLoading && currentMember && !canView);
    return (
        <div className="container mx-auto px-4 py-8">
            <div className="mb-8 flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
                <div className="w-full min-w-0">
                    <h1 className="w-full font-headline text-3xl font-bold tracking-tight">Shopping Center</h1>
                    <p className="text-muted-foreground">Lists in the order you walk the store, and a pantry that shows what is on the shelves.</p>
                </div>
                {currentUser && canView && (
                    <Button asChild variant="outline" className="w-full sm:w-auto">
                        <Link href="/library">
                            <ScanBarcode className="mr-2" aria-hidden /> Barcode Library
                        </Link>
                    </Button>
                )}
            </div>

            {!currentUser && <p className="text-center py-8">Please log in to manage your shopping lists and inventory.</p>}

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
                <ShoppingCenterClient />
            )}
        </div>
    );
}
