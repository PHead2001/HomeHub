'use client';

import { useAuth } from "@/hooks/use-auth";
import { useSessionKnown } from '@/hooks/use-session-known';
import Loading from './loading';
import { AutomationClient } from "@/components/automation-client";
import { SignInPrompt } from "@/components/profile/sign-in-prompt";

export default function AutomationPage() {
    const { currentUser } = useAuth();
    const sessionKnown = useSessionKnown();
    // SL-11: the route skeleton, not the sign-in prompt, until Auth has answered.
    if (!currentUser && !sessionKnown) return <Loading />;
    return (
        <div className="container mx-auto px-4 py-8">
            <div className="mb-8">
                <h1 className="font-headline text-3xl font-bold tracking-tight">House Automation</h1>
                <p className="text-muted-foreground">See what your lights, sensors and devices are doing, straight from Home Assistant. HomeHub only reads states; it never switches anything.</p>
            </div>

            {currentUser ? <AutomationClient /> : <SignInPrompt what="see your smart home" />}
        </div>
    );
}
