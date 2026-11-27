'use client';

import { BarcodeLibraryClient } from "@/components/barcode-library-client";
import { useAuth } from "@/hooks/use-auth";
import { useSessionKnown } from '@/hooks/use-session-known';
import Loading from './loading';
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
                {/* BL-15: a small link, not a full-width button above the content. */}
                <Link href="/shopping" className="inline-flex min-h-11 items-center gap-1 self-start text-sm font-medium text-muted-foreground underline-offset-4 hover:text-foreground hover:underline [@media(pointer:coarse)]:min-h-12">
                    <ArrowLeft className="h-4 w-4" aria-hidden /> Shopping
                </Link>
            </div>

            {!currentUser && <SignInPrompt what="manage your barcode library" />}

            {currentUser && (
                <BarcodeLibraryClient />
            )}
        </div>
    );
}
