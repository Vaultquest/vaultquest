import { Info } from "lucide-react";
import { getApyMetric } from "@/lib/apy-metrics";

export default function ApyMetric({ metric, value, locale, compact = false }) {
  const display = getApyMetric(metric, value, locale);

  return (
    <div className={compact ? "space-y-0.5" : "rounded-xl border border-vault-border bg-vault-surface/40 p-4"}>
      <div className="flex items-center gap-1.5 text-vault-muted">
        <span className="text-[10px] font-bold uppercase tracking-wider">{display.label}</span>
        <span className="group relative inline-flex" tabIndex={0} aria-label={`${display.label}: ${display.description}`}>
          <Info className="h-3.5 w-3.5" aria-hidden="true" />
          <span role="tooltip" className="pointer-events-none absolute bottom-full left-1/2 z-20 mb-2 hidden w-64 -translate-x-1/2 rounded-lg border border-vault-border bg-vault-surface p-2 text-xs normal-case tracking-normal text-vault-text shadow-xl group-hover:block group-focus:block">
            {display.description}
          </span>
        </span>
      </div>
      {display.value === null ? (
        <p className="mt-1 text-sm font-medium text-vault-muted">Not available</p>
      ) : (
        <p className={`${compact ? "text-base" : "mt-1 text-xl"} font-bold text-emerald-500`}>{display.value}</p>
      )}
    </div>
  );
}
