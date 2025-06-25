"use client";

import { useAuth } from "@/hooks/use-auth";
import { ForcePasswordChangeDialog } from "./force-password-change-dialog";

export function PasswordChangeHandler() {
    const { currentUser } = useAuth();
    
    if (currentUser?.forcePasswordChange) {
        return <ForcePasswordChangeDialog />;
    }

    return null;
}
