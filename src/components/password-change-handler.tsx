"use client";

import { useAuth } from "@/hooks/use-auth";
import dynamic from "next/dynamic";

// The dialog's form (react-hook-form and zod) loads only for members who must
// change their password, never on first paint for everyone else.
const ForcePasswordChangeDialog = dynamic(() => import("./force-password-change-dialog").then((mod) => mod.ForcePasswordChangeDialog), { ssr: false });

export function PasswordChangeHandler() {
    const { currentUser } = useAuth();
    
    if (currentUser?.forcePasswordChange) {
        return <ForcePasswordChangeDialog />;
    }

    return null;
}
