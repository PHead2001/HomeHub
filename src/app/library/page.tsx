'use client';

import { BarcodeLibraryClient } from "@/components/barcode-library-client";
import { useAuth } from "@/hooks/use-auth";
import { useSessionKnown } from '@/hooks/use-session-known';
import Loading from './loading';
import { Button } from "@/components/ui/button";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { SignInPrompt } from '@/components/profile/sign-in-prompt';

export default function LibraryPage() {
    const { currentUser } = useAuth();
    const sessionKnown = useSessionKnown();
    // SL-11: the route skeleton, not the sign-in prompt, until Auth has answered.
    if (!currentUser && !sessionKnown) return <Loading />;
    return (
        <div className="container mx-auto px-4 py-8">
            <div className="mb-8 flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
                 <div className="min-w-0">
                    <h1 className="font-headline text-3xl font-bold tracking-tight">Barcode Library</h1>
                    <p className="text-muted-foreground">Products your household has saved, so a scan fills in the name and photo.</p>
                </div>
                <Button asChild variant="outline" className="w-full sm:w-auto">
                    <Link href="/shopping">
                        <ArrowLeft className="mr-2" aria-hidden /> Back to Shopping
                    </Link>
                </Button>
            </div>

            {!currentUser && <SignInPrompt what="manage your barcode library" />}

            {currentUser && (
                <BarcodeLibraryClient />
            )}
        </div>
    );
}
