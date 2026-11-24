'use client';

import { useEffect, useState } from 'react';
import type { HomeAsset, MaintenanceLog, Vehicle } from '@/lib/types';
import { stableSlugify } from '@/lib/utils';
import { deepLinkPlan, isMaintenanceTab, type MaintenanceTab } from '@/lib/maintenance/deep-link';
import { useStableHandler } from './use-stable-handler';
import type { OpenTarget } from './tab-types';

/**
 * The page's tab, selected asset and vehicle, and its links: `?tab=`, record and schedule
 * deep links (applied once per URL, after every listener has answered once: `ready`), and
 * in-page links to a record (pushed to history).
 */
export function useMaintenanceNavigation({ ready, confirmed, assets, vehicles, logs }: {
  ready: boolean;
  /** Every listener has answered from the server: only then is a linked record known to be gone. */
  confirmed: boolean;
  assets: HomeAsset[];
  vehicles: Vehicle[];
  logs: MaintenanceLog[];
}) {
  const [activeTab, setActiveTab] = useState<MaintenanceTab>('overview');
  // The URL whose deep link was applied: once per URL, so later data changes (Mark done on the
  // Reminders tab, another device's edit) never pull the page back to the linked record.
  const [appliedSearch, setAppliedSearch] = useState<string | null>(null);
  const [scrollRequest, setScrollRequest] = useState<{ id: string } | null>(null);
  const [selectedAssetId, setSelectedAssetId] = useState<string | null>(null);
  const [selectedVehicleId, setSelectedVehicleId] = useState<string | null>(null);
  const [highlightedLogId, setHighlightedLogId] = useState<string | null>(null);
  const [highlightedScheduleKey, setHighlightedScheduleKey] = useState<string | null>(null);
  const [deepLinkNotice, setDeepLinkNotice] = useState<string | null>(null);
  const [locationSearch, setLocationSearch] = useState('');

  useEffect(() => {
    const syncLocation = () => setLocationSearch(window.location.search);
    syncLocation();
    window.addEventListener('popstate', syncLocation);
    return () => window.removeEventListener('popstate', syncLocation);
  }, []);

  // Applied while rendering (React's "adjust state when an input changes"), once every listener
  // has answered, so a collection that arrives late never yields a false "no longer available".
  const plan = ready && appliedSearch !== locationSearch ? deepLinkPlan(locationSearch, { assets, vehicles, logs }) : null;
  // A record missing from a cached answer may exist on the server (created on another device):
  // "no longer available" waits for the server's answer.
  if (plan && (!plan.notice || confirmed)) {
    setAppliedSearch(locationSearch);
    setDeepLinkNotice(plan.notice);
    setHighlightedLogId(plan.highlightedLogId);
    setHighlightedScheduleKey(plan.highlightedScheduleKey);
    if (plan.tab) setActiveTab(plan.tab);
    if (plan.selectAssetId) setSelectedAssetId(plan.selectAssetId);
    if (plan.selectVehicleId) setSelectedVehicleId(plan.selectVehicleId);
    if (plan.scrollTo) {
      setScrollRequest({
        id: plan.scrollTo.kind === 'log' ? `maintenance-log-${plan.scrollTo.id}` : `maintenance-schedule-${stableSlugify(plan.scrollTo.id)}`,
      });
    }
  }

  useEffect(() => {
    if (!scrollRequest) return;
    const frame = requestAnimationFrame(() => document.getElementById(scrollRequest.id)?.scrollIntoView({ block: 'center' }));
    return () => cancelAnimationFrame(frame);
  }, [scrollRequest]);

  // Tabs are linkable (`/maintenance?tab=reminders`). Choosing a tab replaces the
  // URL so a refresh or Back keeps the tab, and drops any record link.
  const changeTab = (value: string) => {
    if (!isMaintenanceTab(value)) return;
    setActiveTab(value);
    const search = value === 'overview' ? '' : `?tab=${value}`;
    if (window.location.search !== search) {
      window.history.replaceState(window.history.state, '', `${window.location.pathname}${search}`);
      setAppliedSearch(search);
      setLocationSearch(search);
      setDeepLinkNotice(null);
    }
  };

  const openTarget = (target: { targetType: 'home_asset' | 'vehicle'; targetId: string; deepLink: string; scheduleKey?: string }) => {
    window.history.pushState({}, '', target.deepLink);
    const search = new URL(target.deepLink, window.location.origin).search;
    setAppliedSearch(search);
    setLocationSearch(search);
    setDeepLinkNotice(null);
    setHighlightedLogId(null);
    setHighlightedScheduleKey(target.scheduleKey || null);
    if (target.targetType === 'home_asset') {
      setSelectedAssetId(target.targetId);
      setActiveTab('assets');
    } else {
      setSelectedVehicleId(target.targetId);
      setActiveTab('vehicles');
    }
    if (target.scheduleKey) {
      const elementId = `maintenance-schedule-${stableSlugify(target.scheduleKey)}`;
      requestAnimationFrame(() => document.getElementById(elementId)?.scrollIntoView({ block: 'center' }));
    }
  };

  return {
    activeTab, selectedAssetId, setSelectedAssetId, selectedVehicleId, setSelectedVehicleId,
    highlightedLogId, highlightedScheduleKey, deepLinkNotice,
    changeTab: useStableHandler(changeTab),
    openTarget: useStableHandler(openTarget as OpenTarget),
  };
}
