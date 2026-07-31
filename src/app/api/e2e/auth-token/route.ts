import { generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const E2E_UID = "e2e-owner-uid";
const CUSTOM_TOKEN_AUDIENCE =
  "https://identitytoolkit.googleapis.com/google.identity.identitytoolkit.v1.IdentityToolkit";
const LOOPBACK_EMULATOR_HOST = /^(?:localhost|127\.0\.0\.1|\[::1\]):\d+$/;

let privateKey: KeyObject | null = null;

const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");

const emulatorModeIsSafe = () => {
  const projectId = process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID;
  const authHost = process.env.FIREBASE_AUTH_EMULATOR_HOST;
  const firestoreHost = process.env.FIRESTORE_EMULATOR_HOST;

  return process.env.NEXT_PUBLIC_USE_FIREBASE_EMULATORS === "true"
    && Boolean(projectId?.startsWith("demo-"))
    && Boolean(authHost && LOOPBACK_EMULATOR_HOST.test(authHost))
    && Boolean(firestoreHost && LOOPBACK_EMULATOR_HOST.test(firestoreHost));
};

const createEmulatorCustomToken = () => {
  const projectId = process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID!;
  const now = Math.floor(Date.now() / 1000);
  const serviceAccount = `firebase-e2e@${projectId}.iam.gserviceaccount.com`;
  const header = encode({ alg: "RS256", typ: "JWT" });
  const payload = encode({
    iss: serviceAccount,
    sub: serviceAccount,
    aud: CUSTOM_TOKEN_AUDIENCE,
    iat: now,
    exp: now + 60 * 60,
    uid: E2E_UID,
    claims: { e2e: true },
  });

  if (!privateKey) {
    privateKey = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey;
  }

  const signature = sign("RSA-SHA256", Buffer.from(`${header}.${payload}`), privateKey)
    .toString("base64url");
  return `${header}.${payload}.${signature}`;
};

export async function POST() {
  if (!emulatorModeIsSafe()) {
    return NextResponse.json({ error: "Not found." }, { status: 404 });
  }

  return NextResponse.json(
    { token: createEmulatorCustomToken() },
    {
      headers: {
        "Cache-Control": "no-store",
      },
    }
  );
}
