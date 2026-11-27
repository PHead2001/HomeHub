import { readFileSync } from 'node:fs';
import { initializeTestEnvironment, type RulesTestEnvironment } from '@firebase/rules-unit-testing';
import { doc, setDoc } from 'firebase/firestore';

// A small household for the chores motivation rules (CH-20, CH-28, CH-29).
export type Identity = { uid: string; email: string };
export const projectId = 'demo-homehub-e2e';

export const choreUsers = {
  owner: { uid: 'cm-owner', email: 'cm.owner@example.test' },
  admin: { uid: 'cm-admin', email: 'cm.admin@example.test' },
  member: { uid: 'cm-member', email: 'cm.member@example.test' },
  // May create and edit chores but not assign them to anyone else.
  noAssign: { uid: 'cm-noassign', email: 'cm.noassign@example.test' },
  child: { uid: 'cm-child', email: 'cm.child@example.test' },
} satisfies Record<string, Identity>;

export async function choreRulesEnvironment(house: string): Promise<RulesTestEnvironment> {
  const environment = await initializeTestEnvironment({
    projectId,
    firestore: { rules: readFileSync(process.env.HOMEHUB_FIRESTORE_RULES ?? 'firestore.rules', 'utf8') },
  });
  await environment.withSecurityRulesDisabled(async context => {
    const db = context.firestore();
    await setDoc(doc(db, 'households', house), { name: 'Chores', ownerUid: choreUsers.owner.uid, memberEmails: [] });
    const roles: Record<string, string> = { owner: 'owner', admin: 'admin', member: 'member', noAssign: 'member', child: 'child' };
    for (const [key, user] of Object.entries(choreUsers)) {
      await setDoc(doc(db, 'households', house, 'members', user.uid), {
        ...user, role: roles[key], status: 'active',
        ...(key === 'noAssign' ? { permissions: { 'chores.assign': false, 'chores.edit': true, 'chores.delete': true } } : {}),
      });
    }
  });
  return environment;
}

export const firestoreAs = (environment: RulesTestEnvironment, user: Identity) =>
  environment.authenticatedContext(user.uid, { email: user.email }).firestore();
