export const APY_METRIC = Object.freeze({
  REALIZED: "realized",
  PROJECTED: "projected",
  PRIZE_FUNDED: "prize-funded",
});

export const APY_METRIC_COPY = Object.freeze({
  [APY_METRIC.REALIZED]: Object.freeze({
    label: "Realized APY",
    description: "Annualized return measured from yield the vault has actually generated. Past performance does not guarantee future returns.",
  }),
  [APY_METRIC.PROJECTED]: Object.freeze({
    label: "Projected APY",
    description: "Forward-looking annualized estimate based on the vault strategy. This rate can change and is not guaranteed.",
  }),
  [APY_METRIC.PRIZE_FUNDED]: Object.freeze({
    label: "Prize-funded yield",
    description: "Annualized vault yield allocated to the prize pool. It is prize funding, not a guaranteed return for an individual depositor.",
  }),
});

export function formatApy(value, locale) {
  if (value === null || value === undefined || value === "") return null;
  const numericValue = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(numericValue) || numericValue < 0) return null;

  return `${new Intl.NumberFormat(locale, {
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  }).format(numericValue)}%`;
}

export function getApyMetric(metric, value, locale) {
  const copy = APY_METRIC_COPY[metric];
  if (!copy) throw new TypeError(`Unknown APY metric: ${metric}`);
  return { metric, ...copy, value: formatApy(value, locale) };
}
