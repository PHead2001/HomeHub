
'use client';

import { useAuth } from "@/hooks/use-auth";
import { ShoppingCenterClient } from "@/components/shopping-center-client";
import { Button } from "@/components/ui/button";
import Link from "next/link";
import { ScanBarcode } from "lucide-react";

export default function ShoppingPage() {
    const { currentUser } = useAuth();
    return (
        <div className="container mx-auto px-4 py-8">
            <div className="mb-8 flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
                <div className="w-full min-w-0">
                    <h1 className="w-full font-headline text-3xl font-bold tracking-tight">Shopping Center</h1>
                    <p className="text-muted-foreground">Manage your shopping lists and household inventory.</p>
                </div>
                <Button asChild variant="outline" className="w-full sm:w-auto">
                    <Link href="/library">
                        <ScanBarcode className="mr-2"/> Barcode Library
                    </Link>
                </Button>
            </div>
            
            {!currentUser && <p className="text-center py-8">Please log in to manage your shopping lists and inventory.</p>}

            {currentUser && (
                <ShoppingCenterClient />
            )}
        </div>
    );
}
