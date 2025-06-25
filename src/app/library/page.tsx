
'use client';

import { BarcodeLibraryClient } from "@/components/barcode-library-client";
import { useAuth } from "@/hooks/use-auth";
import { Button } from "@/components/ui/button";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";

export default function LibraryPage() {
    const { currentUser } = useAuth();
    return (
        <div className="container mx-auto px-4 py-8">
            <div className="flex justify-between items-start mb-8">
                 <div>
                    <h1 className="font-headline text-3xl font-bold tracking-tight">Barcode Library</h1>
                    <p className="text-muted-foreground">Manage your custom product information and images.</p>
                </div>
                <Button asChild variant="outline">
                    <Link href="/shopping">
                        <ArrowLeft className="mr-2"/> Back to Shopping
                    </Link>
                </Button>
            </div>
            
            {!currentUser && <p className="text-center py-8">Please log in to manage your barcode library.</p>}

            {currentUser && (
                <BarcodeLibraryClient />
            )}
        </div>
    );
}
