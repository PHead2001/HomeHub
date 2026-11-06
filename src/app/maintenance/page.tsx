
'use client';

import { useAuth } from "@/hooks/use-auth";
import { MaintenanceLogClient } from "@/components/maintenance-log-client";
import { SignInPrompt } from '@/components/profile/sign-in-prompt';

export default function MaintenancePage() {
    const { currentUser } = useAuth();
    return (
        <div className="container mx-auto px-4 py-8">
            {!currentUser && <SignInPrompt what="manage maintenance logs" />}

             {currentUser && (
                 <MaintenanceLogClient />
            )}
        </div>
    );
}
