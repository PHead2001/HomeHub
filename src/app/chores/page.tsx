
'use client';

import { useAuth } from "@/hooks/use-auth";
import { ChoreChartClient } from "@/components/chore-chart-client";

export default function ChoresPage() {
    const { currentUser } = useAuth();
    return (
        <div className="container mx-auto px-4 py-8">
             {/* The header and manager button are now inside the client component */}
             {!currentUser && <p className="text-center py-8">Please log in to manage your chores.</p>}

            {currentUser && (
               <ChoreChartClient />
            )}
        </div>
    );
}
