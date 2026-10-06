#!/usr/bin/env node
/**
 * Focused browser-bundle regression for the account fixture boundary.
 * Run from the repository root after installing its existing dependencies:
 *   node scripts/check-account-fixture-bundle.cjs
 * Optional second argument: an earlier helper file, to reproduce the bug.
 * Uses Next's bundled webpack, not a text-replacement approximation. It does
 * not build the application, contact a wallet, or exercise React hydration.
 */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const crypto = require("node:crypto");
const bundled = require("next/dist/compiled/webpack/webpack");
if (bundled.init) bundled.init();
const webpack = bundled.webpack;
const source = path.resolve(process.argv[2] || "lib/account-wallet-state.js");
const baseline = process.argv[3] && path.resolve(process.argv[3]);
const output = fs.mkdtempSync(path.join(os.tmpdir(), "vq-account-bundle-"));
const hostile = "?mockConnected=true&networkMismatch=true";

function blob(file) {
  const bytes = fs.readFileSync(file);
  return crypto.createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
}

async function compile(nodeEnv, optIn) {
  const directory = path.join(output, `${nodeEnv}-${optIn}`);
  const compiler = webpack({
    mode: "production",
    target: "web",
    entry: { candidate: source, ...(baseline ? { baseline } : {}) },
    output: { path: directory, filename: "[name].cjs", library: { type: "commonjs2" } },
    optimization: { minimize: false, nodeEnv: false },
    plugins: [new webpack.DefinePlugin({
      "process.env.NODE_ENV": JSON.stringify(nodeEnv),
      "process.env.NEXT_PUBLIC_ALLOW_ACCOUNT_TEST_FIXTURES": JSON.stringify(optIn),
    })],
  });
  await new Promise((resolve, reject) => {
    compiler.run((error, stats) => {
      compiler.close((closeError) => {
        if (error || closeError) return reject(error || closeError);
        if (!stats || stats.hasErrors()) return reject(new Error(stats?.toString({ all: false, errors: true }) || "No compilation result"));
        resolve();
      });
    });
  });
  return (name = "candidate", runtimeFlag = false) => {
    const module = { exports: {} };
    const browser = {
      module, exports: module.exports, URLSearchParams,
      process: { env: {} },
      window: { __VQ_ALLOW_ACCOUNT_TEST_FIXTURES__: runtimeFlag },
    };
    vm.runInNewContext(fs.readFileSync(path.join(directory, `${name}.cjs`), "utf8"), browser, { timeout: 1000 });
    return module.exports;
  };
}

async function main() {
  const loadProduction = await compile("production", "false");
  if (baseline) {
    const old = loadProduction("baseline");
    assert.equal(old.areAccountTestFixturesAllowed(), true, "Earlier browser bundle should reproduce the open gate");
    assert.equal(old.parseAccountTestFixtures(hostile).mockConnected, true);
    console.log("REPRODUCED: earlier production bundle accepts hostile fixture URL");
  }
  const current = loadProduction();
  assert.equal(current.areAccountTestFixturesAllowed(), false);
  assert.equal(JSON.stringify(current.parseAccountTestFixtures(hostile)), JSON.stringify({ mockConnected: false, networkMismatch: false, applied: false }));
  const state = (connected, chainId) => current.resolveAccountWalletState({
    wagmiConnected: connected, chainId, supportedChainIds: [43113, 43114],
    fixtures: current.parseAccountTestFixtures(hostile),
  });
  assert.equal(state(false, null).isConnected, false);
  assert.equal(state(true, 43113).isNetworkMismatch, false);
  assert.equal(state(true, 1).isNetworkMismatch, true);
  assert.equal(loadProduction("candidate", true).parseAccountTestFixtures(hostile).applied, true);
  assert.equal((await compile("production", "true"))().parseAccountTestFixtures(hostile).applied, true);
  assert.equal((await compile("development", "false"))().parseAccountTestFixtures(hostile).applied, true);
  console.log(JSON.stringify({ status: "PASS", assertions: 8, next: require("next/package.json").version, webpack: webpack.version, sourceBlob: blob(source), baselineBlob: baseline ? blob(baseline) : null }));
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
}).finally(() => fs.rmSync(output, { recursive: true, force: true }));
