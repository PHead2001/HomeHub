import 'server-only';

import type { QueryDocumentSnapshot } from 'firebase-admin/firestore';
import type { AuthorizedHouseholdUser } from '@/ai/action-auth';
import { adminDb } from '@/lib/server/firebase-admin';
import type { HomeOverviewFacts } from '@/ai/overview-types';

const DAY_MS = 86_400_000;
const label = (value: unknown, fallback: string) => typeof value === 'string'
  ? value.trim().replace(/\s+/g, ' ').slice(0, 100) || fallback
  : fallback;

const toDate = (value: unknown): Date | null => {
  if (value instanceof Date) return value;
  if (value && typeof value === 'object' && 'toDate' in value && typeof value.toDate === 'function') {
    return value.toDate();
  }
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
};

const startOfUtcDay = (value: Date) => new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate()));
const dayDistance = (date: Date, now: Date) => Math.round((startOfUtcDay(date).getTime() - startOfUtcDay(now).getTime()) / DAY_MS);
const getNow = () => {
  const configured = process.env.HOMEHUB_TEST_NOW;
  const parsed = configured ? new Date(configured) : new Date();
  return Number.isNaN(parsed.getTime()) ? new Date() : parsed;
};

const docsData = (snapshot: { docs: QueryDocumentSnapshot[] }): Array<Record<string, unknown> & { id: string }> => snapshot.docs.map(document => ({
  id: document.id,
  ...document.data(),
}));

export const aggregateHomeOverviewFacts = async (user: AuthorizedHouseholdUser): Promise<{
  generatedAt: string;
  facts: HomeOverviewFacts;
}> => {
  const now = getNow();
  const household = adminDb.collection('households').doc(user.householdId);
  const facts: HomeOverviewFacts = {};

  if (user.permissions['chores.view']) {
    const chores = docsData(await household.collection('chores').get());
    const assigned = chores.filter(chore => chore.assignedToEmail === user.email && chore.isCompleted !== true);
    const dated = assigned.map(chore => ({ chore, due: toDate(chore.dueDate) })).filter(item => item.due);
    facts.chores = {
      assignedIncomplete: assigned.length,
      overdue: dated.filter(item => dayDistance(item.due!, now) < 0).length,
      dueToday: dated.filter(item => dayDistance(item.due!, now) === 0).length,
      dueWithinSevenDays: dated.filter(item => {
        const distance = dayDistance(item.due!, now);
        return distance > 0 && distance <= 7;
      }).length,
      urgent: dated
        .sort((left, right) => left.due!.getTime() - right.due!.getTime())
        .slice(0, 5)
        .map(item => ({ label: label(item.chore.task, 'Assigned chore'), due: item.due!.toISOString().slice(0, 10) })),
    };
  }

  if (user.permissions['shopping.view']) {
    const listsSnapshot = await household.collection('shopping-lists').get();
    const itemSnapshots = await Promise.all(listsSnapshot.docs.map(list => list.ref.collection('items').get()));
    const items = itemSnapshots.flatMap(docsData);
    facts.shopping = {
      activeLists: listsSnapshot.size,
      neededItems: items.filter(item => item.status !== 'purchased').length,
      recentlyPurchased: items.filter(item => {
        const created = toDate(item.createdAt);
        return item.status === 'purchased' && created && now.getTime() - created.getTime() <= 7 * DAY_MS;
      }).length,
      outstanding: items.filter(item => item.status !== 'purchased').slice(0, 5).map(item => label(item.name, 'Shopping item')),
    };

    const pantry = docsData(await household.collection('pantry-inventory').get());
    const expirations = pantry.map(item => ({ item, date: toDate(item.expiryDate) })).filter(item => item.date);
    facts.pantry = {
      totalItems: pantry.length,
      expired: expirations.filter(item => dayDistance(item.date!, now) < 0).length,
      expiringWithinSevenDays: expirations.filter(item => {
        const distance = dayDistance(item.date!, now);
        return distance >= 0 && distance <= 7;
      }).length,
      expiringWithinThirtyDays: expirations.filter(item => {
        const distance = dayDistance(item.date!, now);
        return distance >= 0 && distance <= 30;
      }).length,
      nearestExpirations: expirations
        .sort((left, right) => left.date!.getTime() - right.date!.getTime())
        .slice(0, 5)
        .map(item => ({ label: label(item.item.name, 'Pantry item'), due: item.date!.toISOString().slice(0, 10) })),
    };

    facts.barcode = { savedProducts: (await household.collection('barcode-library').count().get()).data().count };
  }

  if (user.permissions['maintenance.view']) {
    const [assetSnapshot, vehicleSnapshot] = await Promise.all([
      household.collection('home-assets').get(),
      household.collection('vehicles').get(),
    ]);
    const assets = docsData(assetSnapshot);
    const vehicles = docsData(vehicleSnapshot);
    const dueItems: Array<{ label: string; due?: Date; overdue: boolean; dueSoon: boolean }> = [];
    let checklistItems = 0;

    for (const asset of assets) {
      for (const schedule of Array.isArray(asset.schedules) ? asset.schedules : []) {
        if (schedule?.mode === 'checklist') {
          checklistItems += 1;
          continue;
        }
        const due = toDate(schedule?.nextDueDate);
        if (!due) continue;
        const distance = dayDistance(due, now);
        dueItems.push({ label: label(schedule?.scheduleName, label(asset.name, 'Asset maintenance')), due, overdue: distance < 0, dueSoon: distance >= 0 && distance <= 7 });
      }
      const warranty = toDate(asset.warrantyExpiration);
      if (warranty) {
        const distance = dayDistance(warranty, now);
        if (distance <= 30) dueItems.push({ label: `${label(asset.name, 'Asset')} warranty`, due: warranty, overdue: distance < 0, dueSoon: distance >= 0 && distance <= 30 });
      }
    }

    for (const vehicle of vehicles) {
      for (const schedule of Array.isArray(vehicle.serviceSchedules) ? vehicle.serviceSchedules : []) {
        if (schedule?.mode === 'checklist') {
          checklistItems += 1;
          continue;
        }
        const due = toDate(schedule?.nextDueDate);
        const dateDistance = due ? dayDistance(due, now) : null;
        const currentMileage = typeof vehicle.currentMileage === 'number' ? vehicle.currentMileage : null;
        const nextMileage = typeof schedule?.nextDueMileage === 'number' ? schedule.nextDueMileage : null;
        const mileageRemaining = currentMileage !== null && nextMileage !== null ? nextMileage - currentMileage : null;
        const overdue = (dateDistance !== null && dateDistance < 0) || (mileageRemaining !== null && mileageRemaining <= 0);
        const dueSoon = (dateDistance !== null && dateDistance >= 0 && dateDistance <= 7)
          || (mileageRemaining !== null && mileageRemaining > 0 && mileageRemaining <= 500);
        if (overdue || dueSoon) dueItems.push({ label: label(schedule?.serviceName, `${label(vehicle.nickname, 'Vehicle')} service`), due: due || undefined, overdue, dueSoon });
      }
      for (const [dateValue, suffix] of [[vehicle.registrationExpiration, 'registration'], [vehicle.inspectionExpiration, 'inspection']] as const) {
        const due = toDate(dateValue);
        if (!due) continue;
        const distance = dayDistance(due, now);
        if (distance <= 30) dueItems.push({ label: `${label(vehicle.nickname, 'Vehicle')} ${suffix}`, due, overdue: distance < 0, dueSoon: distance >= 0 && distance <= 30 });
      }
    }

    facts.maintenance = {
      assetsNeedingAttention: assets.filter(asset => asset.status === 'needs_attention').length
        + vehicles.filter(vehicle => vehicle.status === 'needs_attention').length,
      overdue: dueItems.filter(item => item.overdue).length,
      dueSoon: dueItems.filter(item => !item.overdue && item.dueSoon).length,
      checklistItems,
      urgent: dueItems.sort((left, right) => (left.due?.getTime() || Infinity) - (right.due?.getTime() || Infinity)).slice(0, 6)
        .map(item => ({ label: item.label, ...(item.due ? { due: item.due.toISOString().slice(0, 10) } : {}) })),
    };
  }

  if (user.permissions['pets.view']) {
    const pets = await household.collection('pets').get();
    const logSnapshots = await Promise.all(pets.docs.flatMap(pet => [
      pet.ref.collection('feeding-logs').get(),
      pet.ref.collection('medication-logs').get(),
      pet.ref.collection('care-logs').get(),
    ]));
    const recentCareEntries = logSnapshots.flatMap(docsData).filter(entry => {
      const date = toDate(entry.date);
      return date && now.getTime() - date.getTime() <= 7 * DAY_MS;
    }).length;
    facts.pets = { totalPets: pets.size, recentCareEntries };
  }

  if (user.permissions['notifications.view']) {
    const notifications = docsData(await household.collection('notifications').get()).filter(notification => {
      const expires = toDate(notification.expiresAt);
      const targetMatches = (!notification.targetUserUid || notification.targetUserUid === user.uid)
        && (!notification.targetUserEmail || notification.targetUserEmail === user.email);
      const dismissedBy = notification.dismissedBy && typeof notification.dismissedBy === 'object' ? notification.dismissedBy as Record<string, unknown> : {};
      return targetMatches && (!expires || expires > now) && !notification.resolvedAt && !dismissedBy[user.uid];
    });
    facts.notifications = {
      unread: notifications.filter(notification => {
        const readBy = notification.readBy && typeof notification.readBy === 'object' ? notification.readBy as Record<string, unknown> : {};
        return !readBy[user.uid] && notification.isRead !== true;
      }).length,
      urgent: notifications.filter(notification => notification.category === 'maintenance' || notification.category === 'system')
        .slice(0, 5).map(notification => label(notification.title || notification.message, 'Notification')),
    };
  }

  if (user.permissions['household.manageMembers']) {
    const members = docsData(await household.collection('members').get());
    facts.household = {
      activeMembers: members.filter(member => member.status !== 'pending' && member.role !== 'newuser').length,
      pendingApprovals: members.filter(member => member.status === 'pending' || member.role === 'newuser').length,
    };
    if (user.permissions['household.manageInvites']) {
      const invites = await adminDb.collection('inviteCodes').where('householdId', '==', user.householdId).get();
      facts.household.activeInvites = docsData(invites).filter(invite => !invite.revokedAt && (toDate(invite.expiresAt)?.getTime() || 0) > now.getTime()).length;
    }
  }

  return { generatedAt: now.toISOString(), facts };
};
