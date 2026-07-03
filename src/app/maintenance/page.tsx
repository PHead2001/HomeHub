
'use client';

import { useAuth } from "@/hooks/use-auth";
import { MaintenanceLogClient } from "@/components/maintenance-log-client";

export default function MaintenancePage() {
    const { currentUser } = useAuth();
    return (
        <div className="container mx-auto px-4 py-8">
            {!currentUser && <p className="text-center py-8">Please log in to manage maintenance logs.</p>}

             {currentUser && (
                 <MaintenanceLogClient />
            )}
        </div>
    );
}
