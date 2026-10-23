"use client";

import { useEffect } from "react";

/**
 * Campaign telemetry from customer surfaces (0160): one impression per
 * campaign per browser session, and every tap. Fire-and-forget beacons to
 * /api/campaigns/track — never blocks or throws into the UI. Admin previews
 * do not render these components with live campaign data.
 */
export function trackCampaign(campaignId: string, kind: "impression" | "click", itemId?: string | null) {
  const body = JSON.stringify({ campaignId, kind, itemId: itemId ?? null });
  try {
    if (typeof navigator !== "undefined" && "sendBeacon" in navigator) {
      navigator.sendBeacon("/api/campaigns/track", new Blob([body], { type: "application/json" }));
      return;
    }
    void fetch("/api/campaigns/track", { method: "POST", headers: { "content-type": "application/json" }, body, keepalive: true });
  } catch {
    // best-effort
  }
}

const seen = new Set<string>();

/** One impression per campaign per session (the same card re-rendering counts once). */
export function useCampaignImpression(campaignId: string | null | undefined, itemId?: string | null) {
  useEffect(() => {
    if (!campaignId) return;
    const key = `campaign-seen:${campaignId}:${itemId ?? ""}`;
    if (seen.has(key)) return;
    seen.add(key);
    try {
      if (sessionStorage.getItem(key)) return;
      sessionStorage.setItem(key, "1");
    } catch {
      // storage blocked: the in-memory set still keeps it to once per page life
    }
    trackCampaign(campaignId, "impression", itemId);
  }, [campaignId, itemId]);
}
