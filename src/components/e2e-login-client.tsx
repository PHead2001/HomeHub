"use client";

import { useEffect, useState } from "react";
import { signInWithCustomToken } from "firebase/auth";
import { useRouter } from "next/navigation";
import { Loader2 } from "lucide-react";
import { auth } from "@/lib/firebase";

export function E2ELoginClient({ uid }: { uid?: string }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;

    const authenticate = async () => {
      try {
        const response = await fetch("/api/e2e/auth-token", {
          method: "POST",
          cache: "no-store",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(uid ? { uid } : {}),
        });
        if (!response.ok) {
          throw new Error("The emulator-only authentication endpoint is unavailable.");
        }

        const body = await response.json() as { token?: string };
        if (!body.token) {
          throw new Error("The emulator authentication endpoint returned no token.");
        }

        await signInWithCustomToken(auth, body.token);
        if (active) {
          router.replace("/");
        }
      } catch (authError) {
        if (active) {
          setError(authError instanceof Error ? authError.message : "E2E authentication failed.");
        }
      }
    };

    void authenticate();
    return () => {
      active = false;
    };
  }, [router, uid]);

  return (
    <div className="container mx-auto flex min-h-[60vh] items-center justify-center px-4 py-8">
      <div className="flex max-w-md flex-col items-center gap-3 text-center">
        {error ? (
          <>
            <h1 className="font-headline text-2xl font-bold">E2E login failed</h1>
            <p className="text-sm text-destructive">{error}</p>
          </>
        ) : (
          <>
            <Loader2 className="h-8 w-8 animate-spin" />
            <h1 className="font-headline text-2xl font-bold">Signing in to the Firebase emulators</h1>
          </>
        )}
      </div>
    </div>
  );
}
