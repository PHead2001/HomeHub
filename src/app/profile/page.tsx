'use client';

import { useAuth } from "@/hooks/use-auth";
import { ProfileClient } from "@/components/profile-client";
import { SignInPrompt } from "@/components/profile/sign-in-prompt";

export default function ProfilePage() {
    const { currentUser } = useAuth();
    return (
        <div className="container mx-auto px-4 py-8">
            <div className="mb-8">
                <h1 className="font-headline text-3xl font-bold tracking-tight">Your Profile</h1>
                <p className="text-muted-foreground">Manage your personal information and settings.</p>
            </div>

            {currentUser ? <ProfileClient /> : <SignInPrompt what="see your profile" />}
        </div>
    );
}
