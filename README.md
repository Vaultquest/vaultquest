# VaultQuest

A Stellar/Soroban no-loss prize-savings dApp. Users deposit into pooled
vaults; yield is awarded to a random winner each round while every deposit
remains withdrawable in full.

## Packages

| Path | What it does |
|---|---|
| [`backend/`](./backend) | Fastify action-ledger and reconciliation service |
| [`contracts/`](./contracts) | Soroban smart contracts (Rust) |
| [`stellar-wallet-connect/`](./stellar-wallet-connect) | Drop-in wallet module — React + Astro components |
| [`services/`](./services) | Shared TypeScript service helpers (escrow, quests, savings) |
| [`e2e/`](./e2e) | Playwright end-to-end tests |
| [`docs/`](./docs) | Architecture, state model, testing notes |
| [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md) | Cross-stack architecture diagram and action/event flow |

## Quick start

```bash
git clone https://github.com/Vaultquest/vaultquest.git
cd vaultquest
pnpm install

# Setup database (migrations and mock seed data)
pnpm db:setup

# Start development
pnpm dev
```

For per-package setup, see the README inside each folder.

## Support-ticket storage

The Next.js `POST /api/support/tickets` route stores accepted receipts in a
JSONL file through [FileSupportTicketStore](./lib/support-ticket-store.js).
The `pnpm db:setup` command above configures the backend database; it does
not create or migrate this ticket file.

By default, the file is `.data/support-tickets.jsonl` under the Next.js
process's working directory. Set the server-side `SUPPORT_TICKET_STORE_PATH`
before starting the app to use an absolute path on storage managed by your
deployment. Replace the example path with your retained storage location:

```bash
export SUPPORT_TICKET_STORE_PATH='/absolute/retained/path/support-tickets.jsonl'
pnpm dev
```

For production, supply the same variable to `pnpm start` after the normal
application build. The server process must be able to read the existing file
and create or append files in its parent directory. Retain that storage
across process restarts and redeployments; an ephemeral container filesystem
does not preserve accepted receipts when the container is replaced.

The store is initialized lazily on first use and keeps its path and loaded
receipt indexes in memory. Stop the app before moving or restoring the file,
then restart it with the intended path. Changing the environment variable does
not move prior tickets; preserve the existing JSONL when moving storage. Each store instance serializes its own writes and keeps
rate counters in memory. Use one active writer per file: independent app
instances do not share a write queue or rate counters. Rate counters reset on
restart; receipt and duplicate indexes reload from the retained file. This
file store does not establish coordination between independent writers or
power-loss durability.

### Check receipt persistence locally

With the app running, submit an illustrative ticket to its origin (adjust
the port below for your local setup). Use a distinct description when checking
a new acceptance; an equivalent retry may return the earlier receipt.

```bash
SUPPORT_APP_ORIGIN='http://localhost:3000'
curl --include --silent --show-error \
  -H 'content-type: application/json' \
  --data-binary '{"name":"Local Check","email":"support-check@example.com","category":"general","description":"Local receipt storage check with a unique label."}' \
  "$SUPPORT_APP_ORIGIN/api/support/tickets"
```

A new accepted ticket returns HTTP 201 with `data.id`; a duplicate returns
HTTP 200 with `data.duplicate: true`. Copy the receipt ID, stop and restart
the app using the same storage path, then read it back:

```bash
SUPPORT_TICKET_RECEIPT_ID='<data.id from the POST response>'
curl --include --silent --show-error \
  "$SUPPORT_APP_ORIGIN/api/support/tickets?id=$SUPPORT_TICKET_RECEIPT_ID"
```

A retained receipt returns HTTP 200 with the same ID, status, creation time,
and category. A 503 on new submission means intake was not confirmed; keep
the draft and retry. See the [testing guide](./docs/TESTING.md) for the existing
retry tests and the scope of the historical browser and restart evidence.

## Contributing

We welcome contributions from everyone. Before opening a PR, please read
[**CONTRIBUTING.md**](./CONTRIBUTING.md) — it covers:

- How to fork the canonical repository and push to your own fork
- How to choose an issue (good-first, frontend, backend, contracts, docs)
- Local setup and validation commands
- PR expectations (screenshots, tests, linked issues)
- When to ask maintainers before starting
- Accessibility and code style expectations

## License

License details are managed separately.
