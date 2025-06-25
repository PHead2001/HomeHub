
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
            <div className="flex justify-between items-start mb-8">
                <div>
                    <h1 className="font-headline text-3xl font-bold tracking-tight">Shopping Center</h1>
                    <p className="text-muted-foreground">Manage your shopping lists and household inventory.</p>
                </div>
                <Button asChild variant="outline">
                    <Link href="/library">
                        <ScanBarcode className="mr-2"/> Manage Barcode Library
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
