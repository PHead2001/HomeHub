import { notFound } from "next/navigation";
import { E2ELoginClient } from "@/components/e2e-login-client";

export default function E2ELoginPage() {
  const enabled = process.env.NEXT_PUBLIC_USE_FIREBASE_EMULATORS === "true"
    && process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID?.startsWith("demo-");

  if (!enabled) {
    notFound();
  }

  return <E2ELoginClient />;
}
