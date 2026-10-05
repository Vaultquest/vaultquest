# Retry parent freshness

A displayed queue row is not an authoritative preflight. The client now reads the parent when a caller has not supplied a fresh preflight, binds that record to the original action ID and active wallet, applies the existing retry policy, and builds from the freshly read payload. A supplied null record is rejected, not replaced by the displayed row.

The component no longer catches a failed parent read and silently substitutes stale state. A failed or missing read stops before creating an attempt or invoking the signing callback. Existing duplicate-click ownership and asynchronous wallet-state isolation are unchanged. A matching preflight is reused without a second GET.

## Executed client observations

Node 22.16.0 executed the actual original and repaired client/policy modules with controlled HTTP response fixtures. Eight negative cases (503, transport error, null parent, different parent ID, missing wallet, different wallet, confirmed parent, and an explicit null preflight) all created an attempt and invoked the signing callback before the repair; all eight now stop without a POST or signing callback. Two positive cases (fresh GET and reused matching preflight) each make exactly one POST and invoke signing only when explicitly requested; both use the current amount rather than the stale displayed amount. The reused case makes no additional GET.

Ten focused behavioral cases passed. The maintained Vitest client file includes the corresponding regression cases and adjusted successful-preflight fixture; the full Vitest suite and React rendering were not executed in this follow-through. No external HTTP request, live wallet signature, dependency installation or application build was performed for this client check.

This prevents client-side stale-read fallback; it is not a server transaction lock across the interval between preflight and creation. Callers supplying a preflight remain responsible for obtaining it freshly. The existing backend cancellation concurrency fix is independent and preserved.
