# APY metric taxonomy

VaultQuest displays three yield concepts separately. They must not be added together or presented as interchangeable rates.

| Metric | Meaning | Missing data |
| --- | --- | --- |
| Realized APY | Annualized return calculated from yield the vault has actually generated over a defined observation period. | Show `Not available`; do not substitute projected APY. |
| Projected APY | Forward-looking annualized strategy estimate. It can change and is not guaranteed. | Show `Not available`; do not substitute zero. |
| Prize-funded yield | Annualized vault yield allocated to fund prizes. This is not an individual depositor's guaranteed return. | Show `Not available`; do not infer it from prize size. |

## Data contract

Rates are percentage-point values (`5.2` means `5.2%`). `null`, `undefined`, empty, non-finite, negative, or otherwise invalid values mean unavailable. A numeric zero is valid measured data and renders as `0%`.

The existing vault catalog field `apy` predates this taxonomy and is treated as **projected APY only**. Realized and prize-funded values must come from their own data sources when those become available. UI code must not manufacture either value from projected APY.

Formatting is centralized in `lib/apy-metrics.js` and uses `Intl.NumberFormat`, so decimal separators follow the viewer's locale.
