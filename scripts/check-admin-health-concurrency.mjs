// Node 20+: node --experimental-vm-modules scripts/check-admin-health-concurrency.mjs
// Executes the unchanged route/probes over real loopback HTTP. Import adapters
// isolate Next serialization, health classification and the Stellar SDK codec.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { performance } from "node:perf_hooks";
import { createContext, SourceTextModule, SyntheticModule } from "node:vm";

const args = process.argv.slice(2);
const baseline = args.includes("--uncoalesced");
const sourceArg = args.find((arg) => !arg.startsWith("--"));
assert(args.every((arg) => arg === "--uncoalesced" || arg === sourceArg), "unknown argument");
const sourcePath = sourceArg || new URL("../app/api/admin/health/route.js", import.meta.url);
const source = await readFile(sourcePath, "utf8");
const requests = [];
let unavailable = false;
let rejectCollection = false;
let observation = 0;
const server = createServer(async (request, response) => {
  let body = "";
  for await (const part of request) body += part;
  const method = body ? JSON.parse(body).method : request.url;
  requests.push(method);
  const timestamp = new Date().toISOString();
  const result = {
    getHealth: { status: "healthy" },
    getNetwork: { passphrase: "local network" },
    getLedgerEntries: { entries: [{ xdr: "local-hash" }] },
  }[method];
  const payload = result ? { result } : {
    "/horizon": { network_passphrase: "local network" },
    "/health/indexer": {
      status: "healthy", latest_ledger: observation, sync_lag: 0,
      last_sync_time: timestamp, last_success_sync_time: timestamp,
    },
    "/runtime": {
      observedAt: timestamp, contractId: "local-contract",
      protocolParameters: { observation: String(observation) },
    },
  }[method];
  assert(payload, `unexpected probe ${method}`);
  // Keep the observation pending long enough for a real overlapping burst.
  setTimeout(() => {
    response.writeHead(unavailable && method === "/horizon" ? 503 : 200, {
      "Content-Type": "application/json",
    });
    response.end(JSON.stringify(payload));
  }, 25);
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const worstHealth = (...states) => states.includes("degraded") ? "degraded" : "healthy";
const provenance = {
  CANONICAL_PROVENANCE: {
    network: { horizonUrl: `${base}/horizon`, sorobanRpcUrl: `${base}/soroban` },
    contract: { contractId: "local-contract" },
  },
  evaluateRpcHealth: (probe) => ({ ...probe, status: probe.ok ? "healthy" : "degraded" }),
  evaluateIndexerHealth: (probe) => probe,
  verifyContractProvenance: (hash) => ({ status: hash ? "healthy" : "degraded" }),
  detectConfigDrift: (config) => ({ status: config ? "healthy" : "degraded", config }),
  worstHealth,
  aggregateAdminHealth: (input) => {
    if (rejectCollection) throw new Error("collection failed");
    return { ...input, status: worstHealth(input.rpc.status, input.indexer.status,
      input.contract.status, input.configDrift.status) };
  },
};
const context = createContext({
  fetch, AbortController, setTimeout, clearTimeout, Date, Error,
  process: { env: { NEXT_PUBLIC_BACKEND_URL: base, ADMIN_RUNTIME_CONFIG_URL: `${base}/runtime` } },
});
const imports = {
  "next/server": { NextResponse: { json: (body, init) => Response.json(body, init) } },
  "@/lib/deployment-provenance": provenance,
  "@vaultquest/stellar-wallet-connect/admin-provenance": {
    contractInstanceLedgerKey: () => "local-ledger-key",
    wasmHashFromContractInstance: (value) => value,
  },
};
const route = new SourceTextModule(source, { context, identifier: String(sourcePath) });
const expectedMethods = ["/health/indexer", "/horizon", "/runtime", "getHealth", "getLedgerEntries", "getNetwork"];
const observations = [];
try {
  await route.link((specifier) => {
    const bindings = imports[specifier];
    assert(bindings, `unexpected route import ${specifier}`);
    return new SyntheticModule(Object.keys(bindings), function () {
      for (const [key, value] of Object.entries(bindings)) this.setExport(key, value);
    }, { context });
  });
  await route.evaluate();

  async function burst(label, callers, status, rejected = false) {
    observation += 1;
    const start = requests.length;
    const started = performance.now();
    const results = await Promise.allSettled(Array.from({ length: callers }, () => route.namespace.GET()));
    const elapsedMs = performance.now() - started;
    const actual = requests.slice(start);
    const batches = baseline ? callers : 1;
    for (const method of expectedMethods) {
      assert.equal(actual.filter((item) => item === method).length, batches, `${label}: ${method}`);
    }
    assert.equal(actual.length, 6 * batches, `${label}: total dependency requests`);
    if (rejected) {
      assert(results.every((result) => result.status === "rejected" && result.reason.message === "collection failed"));
    } else {
      assert(results.every((result) => result.status === "fulfilled"));
      const responses = results.map((result) => result.value);
      assert.equal(new Set(responses).size, callers, "response bodies must not be shared");
      for (const response of responses) {
        assert.equal(response.status, status);
        assert.equal(response.headers.get("cache-control"), "no-store");
        const payload = await response.json();
        assert.equal(payload.indexer.latestLedger, observation, "completed snapshots must not be reused");
      }
    }
    observations.push({ label, callers, dependencyRequests: actual.length, elapsedMs });
  }

  await burst("overlapping refreshes", 25, 200);
  await burst("fresh refresh after settlement", 1, 200);
  unavailable = true;
  await burst("dependency failure", 5, 503);
  unavailable = false;
  await burst("dependency recovery", 1, 200);
  rejectCollection = true;
  await burst("collection rejection", 5, null, true);
  rejectCollection = false;
  await burst("refresh after rejection", 1, 200);
  console.log(JSON.stringify({
    sourceSha256: createHash("sha256").update(source).digest("hex"),
    node: process.version, mode: baseline ? "uncoalesced" : "in-flight sharing",
    boundary: "production route/probes and native HTTP; imported serializer/classifiers/SDK isolated",
    observations,
  }, null, 2));
} finally {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}
