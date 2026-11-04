"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { ADDRESSES } from "@/lib/data";
import type { Address } from "@/types";
import { isSupabaseConfigured } from "@/lib/supabase/config";
import { useFeature } from "@/components/features/features-provider";

export type SavedAddress = Address & {
  lat?: number | null;
  lng?: number | null;
};

export interface AddressInput {
  label: string;
  line: string;
  lat?: number | null;
  lng?: number | null;
  isDefault?: boolean;
}

async function fetchAddresses(): Promise<SavedAddress[]> {
  const res = await fetch("/api/addresses");
  const data = await res.json();
  return data.addresses ?? [];
}

/** Keep the current selection if it survived the refresh, else the default. */
function pickSelected(list: SavedAddress[], prev: string): string {
  if (prev && list.some((a) => a.id === prev)) return prev;
  return list.find((a) => a.isDefault)?.id ?? list[0]?.id ?? "";
}

/**
 * The address book, or with `customer.saved_addresses` off (Admin → App features)
 * just this page's memory: the address typed for this order is usable at checkout
 * but goes no further than the order itself. Same code path as demo mode, and no
 * call to the routes, which would refuse.
 */
export function useSavedAddresses() {
  const router = useRouter();
  const addressBookOn = useFeature("customer.saved_addresses");
  const stored = isSupabaseConfigured && addressBookOn;
  const [addresses, setAddresses] = useState<SavedAddress[]>(
    isSupabaseConfigured ? [] : ADDRESSES
  );
  const [loading, setLoading] = useState(isSupabaseConfigured);
  const [selectedId, setSelectedId] = useState<string>(
    isSupabaseConfigured
      ? ""
      : (ADDRESSES.find((a) => a.isDefault)?.id ?? ADDRESSES[0]?.id ?? "")
  );

  const adopt = useCallback((list: SavedAddress[]) => {
    setAddresses(list);
    setSelectedId((prev) => pickSelected(list, prev));
  }, []);

  /** Re-read the list after a change. Called from event handlers, never on mount. */
  const refresh = useCallback(async () => {
    if (!isSupabaseConfigured) {
      adopt(ADDRESSES);
      setLoading(false);
      return;
    }
    if (!stored) return;

    setLoading(true);
    try {
      adopt(await fetchAddresses());
    } catch {
      setAddresses([]);
      setSelectedId("");
    } finally {
      setLoading(false);
    }
  }, [adopt, stored]);

  // The first load is deliberately not `refresh()`: refresh sets state before it
  // awaits (the spinner, and the whole demo-mode branch), and doing that
  // synchronously inside an effect makes React render twice before it can paint.
  // Here the initial state already describes both cases — demo mode is seeded,
  // configured mode starts out loading — so the effect only has to fill in the
  // answer once it actually has one.
  useEffect(() => {
    if (!isSupabaseConfigured) return;
    if (!stored) {
      // This person's answer can land after the "for everyone" one started a read.
      setAddresses((prev) => prev.filter((a) => a.id.startsWith("once-")));
      setLoading(false);
      return;
    }

    let alive = true;
    void (async () => {
      try {
        const list = await fetchAddresses();
        if (alive) adopt(list);
      } catch {
        if (alive) setAddresses([]);
      } finally {
        if (alive) setLoading(false);
      }
    })();

    return () => {
      alive = false;
    };
  }, [adopt, stored]);

  const selected =
    addresses.find((a) => a.id === selectedId) ?? addresses[0] ?? null;

  const create = useCallback(
    async (input: AddressInput) => {
      if (!stored) {
        const mock: SavedAddress = {
          id: `${isSupabaseConfigured ? "once" : "demo"}-${Date.now()}`,
          label: input.label,
          line: input.line,
          lat: input.lat ?? null,
          lng: input.lng ?? null,
          isDefault: addresses.length === 0,
        };
        setAddresses((prev) => [...prev, mock]);
        setSelectedId(mock.id);
        return mock;
      }

      const res = await fetch("/api/addresses", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      });
      const data = await res.json();
      if (!res.ok || !data.address) throw new Error("save_failed");
      await refresh();
      // Home and Profile quote the default address and the count from the
      // server; the router would otherwise keep showing the old ones.
      router.refresh();
      setSelectedId(data.address.id);
      return data.address as SavedAddress;
    },
    [addresses.length, refresh, router, stored]
  );

  const update = useCallback(
    async (id: string, input: Partial<AddressInput>) => {
      if (!stored) {
        setAddresses((prev) =>
          prev.map((a) =>
            a.id === id
              ? {
                  ...a,
                  ...input,
                  label: input.label ?? a.label,
                  line: input.line ?? a.line,
                }
              : a
          )
        );
        return true;
      }

      const res = await fetch(`/api/addresses/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      });
      if (!res.ok) throw new Error("update_failed");
      await refresh();
      router.refresh();
      return true;
    },
    [refresh, router, stored]
  );

  const remove = useCallback(
    async (id: string) => {
      if (!stored) {
        setAddresses((prev) => prev.filter((a) => a.id !== id));
        setSelectedId((prev) => (prev === id ? "" : prev));
        return true;
      }

      const res = await fetch(`/api/addresses/${id}`, { method: "DELETE" });
      if (!res.ok) throw new Error("delete_failed");
      await refresh();
      router.refresh();
      return true;
    },
    [refresh, router, stored]
  );

  const setDefault = useCallback(
    (id: string) => update(id, { isDefault: true }),
    [update]
  );

  return {
    addresses,
    loading,
    selectedId,
    setSelectedId,
    selected,
    refresh,
    create,
    update,
    remove,
    setDefault,
  };
}
