'use client';

import { useEffect, useMemo, useState } from 'react';
import type { HomeAsset, MaintenanceLog, Vehicle } from '@/lib/types';
import { stableSlugify } from '@/lib/utils';
import { deepLinkPlan, isMaintenanceTab, type MaintenanceTab } from '@/lib/maintenance/deep-link';
import { parseFilters, serializeFilters, type MaintenanceFilters } from '@/lib/maintenance/filters';
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
  // A record the page was asked to show (deep link, in-page link): on a phone its detail opens
  // in a sheet (MA-17). Counted, so the same record asked for twice opens it again.
  const [detailRequest, setDetailRequest] = useState<{ kind: 'asset' | 'vehicle'; id: string; n: number } | null>(null);
  const requestDetail = (kind: 'asset' | 'vehicle', id: string) =>
    setDetailRequest((previous) => ({ kind, id, n: (previous?.n ?? 0) + 1 }));
  // Location, category and search (MA-21) live in the URL next to ?tab= and the record links.
  const filters = useMemo(() => parseFilters(locationSearch), [locationSearch]);

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
    if (plan.selectAssetId) {
      setSelectedAssetId(plan.selectAssetId);
      requestDetail('asset', plan.selectAssetId);
    }
    if (plan.selectVehicleId) {
      setSelectedVehicleId(plan.selectVehicleId);
      requestDetail('vehicle', plan.selectVehicleId);
    }
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

  // Writes a query string in place (no history entry) and marks it applied, so the deep-link
  // plan above does not run again for it.
  const replaceSearch = (search: string) => {
    if (window.location.search === search) return;
    window.history.replaceState(window.history.state, '', `${window.location.pathname}${search}`);
    setAppliedSearch(search);
    setLocationSearch(search);
  };

  // Tabs are linkable (`/maintenance?tab=reminders`). Choosing a tab replaces the
  // URL so a refresh or Back keeps the tab, and drops any record link; the
  // location, category and search filters stay.
  const changeTab = (value: string) => {
    if (!isMaintenanceTab(value)) return;
    setActiveTab(value);
    const search = serializeFilters(value === 'overview' ? '' : `?tab=${value}`, parseFilters(window.location.search));
    if (window.location.search !== search) {
      replaceSearch(search);
      setDeepLinkNotice(null);
    }
  };

  /** Sets the filters in the URL, keeping every other parameter (tab, record links). */
  const setFilters = (next: MaintenanceFilters) => replaceSearch(serializeFilters(window.location.search, next));

  const openTarget = (target: { targetType: 'home_asset' | 'vehicle'; targetId: string; deepLink: string; scheduleKey?: string }) => {
    // The filters stay; the record asked for is shown even when they would hide its card.
    const url = new URL(target.deepLink, window.location.origin);
    const search = serializeFilters(url.search, parseFilters(window.location.search));
    window.history.pushState({}, '', `${url.pathname}${search}`);
    setAppliedSearch(search);
    setLocationSearch(search);
    setDeepLinkNotice(null);
    setHighlightedLogId(null);
    setHighlightedScheduleKey(target.scheduleKey || null);
    if (target.targetType === 'home_asset') {
      setSelectedAssetId(target.targetId);
      setActiveTab('assets');
      requestDetail('asset', target.targetId);
    } else {
      setSelectedVehicleId(target.targetId);
      setActiveTab('vehicles');
      requestDetail('vehicle', target.targetId);
    }
    if (target.scheduleKey) {
      const elementId = `maintenance-schedule-${stableSlugify(target.scheduleKey)}`;
      requestAnimationFrame(() => document.getElementById(elementId)?.scrollIntoView({ block: 'center' }));
    }
  };

  return {
    activeTab, selectedAssetId, setSelectedAssetId, selectedVehicleId, setSelectedVehicleId,
    highlightedLogId, highlightedScheduleKey, deepLinkNotice, filters, detailRequest,
    changeTab: useStableHandler(changeTab),
    setFilters: useStableHandler(setFilters),
    openTarget: useStableHandler(openTarget as OpenTarget),
  };
}
