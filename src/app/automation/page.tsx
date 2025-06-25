
'use client';

import { useAuth } from "@/hooks/use-auth";
import { AutomationClient } from "@/components/automation-client";
import { Card, CardContent } from "@/components/ui/card";

export default function AutomationPage() {
    const { currentUser } = useAuth();
    return (
        <div className="container mx-auto px-4 py-8">
            <div className="mb-8">
                <h1 className="font-headline text-3xl font-bold tracking-tight">House Automation</h1>
                <p className="text-muted-foreground">Control and manage your smart home devices via Home Assistant.</p>
            </div>
            
            {!currentUser && (
                <Card className="text-center py-16">
                    <CardContent>
                        <p>Please log in to manage your smart home.</p>
                    </CardContent>
                </Card>
            )}

             {currentUser && (
                 <AutomationClient />
            )}
        </div>
    );
}
