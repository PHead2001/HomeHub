import { NotificationCenterClient } from "@/components/notification-center-client";
import { sectionMetadata } from '@/lib/shell/page-titles';

// SL-13: the page title.
export const metadata = sectionMetadata('notifications');

export default function NotificationsPage() {
  return <NotificationCenterClient />;
}
