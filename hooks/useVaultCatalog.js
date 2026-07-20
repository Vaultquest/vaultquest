"use client";

import { useQuery } from "@tanstack/react-query";
import { classifyVaultData } from "@/lib/vault-data-freshness";

async function fetchVaultCatalog() {
  const response = await fetch("/api/vaults", { cache: "no-store" });
  if (!response.ok) throw new Error(`Vault data request failed (${response.status})`);

  const payload = await response.json();
  return {
    vaults: Array.isArray(payload.vaults) ? payload.vaults : [],
    updatedAt: payload.updatedAt || payload.indexedAt || null,
    degraded: Boolean(payload.degraded),
  };
}

export function useVaultCatalog() {
  const query = useQuery({
    queryKey: ["vault-catalog"],
    queryFn: fetchVaultCatalog,
    staleTime: 30_000,
    retry: 1,
  });

  const freshness = classifyVaultData({
    updatedAt: query.data?.updatedAt,
    degraded: query.data?.degraded,
    hasData: Boolean(query.data?.vaults),
    error: query.error,
  });

  return { ...query, freshness };
}
