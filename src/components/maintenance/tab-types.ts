import type * as React from 'react';
import type { HealthResult } from '@/lib/maintenance/health';
import type { HomeAsset, MaintenanceLog, Vehicle } from '@/lib/types';
import type { LogList } from './log-list';

/** Everything a LogList takes except the logs and its empty copy: the page builds it once per render inputs. */
export type LogListShared = Omit<React.ComponentProps<typeof LogList>, 'logs' | 'emptyTitle' | 'emptyDescription' | 'highlightedLogId'>;

/** Opens a record (and optionally one of its schedules) from a link inside the page. */
export type OpenTarget = (target: { targetType: 'home_asset' | 'vehicle'; targetId: string; deepLink: string; scheduleKey?: string }) => void;

export type HealthTargets = Record<string, HealthResult>;

export type RecentSummary = { recentLogs: number; recentCost: number; needingAttention: number };

export type { HomeAsset, MaintenanceLog, Vehicle };
