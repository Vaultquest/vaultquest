// Run with Node 22+: node --test scripts/check-support-wallet-dedupe.mjs
// Uses the real file-backed store; no Next server or wallet authentication is claimed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { FileSupportTicketStore, MemorySupportTicketStore } from '../lib/support-ticket-store.js';

const base = { name: 'Ada', email: 'ada@example.com', category: 'wallet', description: 'Cannot connect wallet.' };
const wallets = [null, 'G'.padEnd(56, 'A'), 'G'.padEnd(56, 'B')];
const meta = { clientKey: 'same-client' };
const options = () => ({ now: () => 1_000_000, random: (() => { let n = 0; return () => (n += 0.01); })(), rateLimit: { max: 20, windowMs: 60_000 } });

test('distinct wallet contexts persist separately and remain separately deduplicated after restart', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'support-wallet-dedupe-'));
  try {
    const file = path.join(dir, 'tickets.jsonl');
    const writer = new FileSupportTicketStore(file, options());
    const results = await Promise.all(wallets.map((wallet_address, i) =>
      writer.create({ ...base, wallet_address, idempotency_key: `first-${i}` }, meta)));
    assert.equal(new Set(results.map(({ ticket }) => ticket.id)).size, 3);
    assert.deepEqual(results.map(({ duplicate }) => duplicate), [false, false, false]);
    assert.deepEqual(results.map(({ ticket }) => ticket.wallet_address), wallets);
    const bytes = await fs.readFile(file, 'utf8');
    assert.equal(bytes.trim().split('\n').length, 3);

    const reader = new FileSupportTicketStore(file, options());
    for (const i of [2, 0, 1]) {
      const retry = await reader.create({ ...base, wallet_address: wallets[i], idempotency_key: `retry-${i}` }, meta);
      assert.equal(retry.duplicate, true);
      assert.equal(retry.ticket.id, results[i].ticket.id);
    }
    const replayBytes = await fs.readFile(file, 'utf8');
    assert.equal(replayBytes.startsWith(bytes), true);
    const rows = replayBytes.trim().split('\n').map(JSON.parse);
    assert.deepEqual(rows.filter((row) => row.id), results.map(({ ticket }) => ticket));
    assert.equal(rows.length, 6);
    assert.deepEqual(rows.filter((row) => row.record_type === 'idempotency_alias')
      .map(({ idempotency_key, ticket_id }) => ({ idempotency_key, ticket_id })),
    [2, 0, 1].map((i) => ({ idempotency_key: `retry-${i}`, ticket_id: results[i].ticket.id })));
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('changed name is retained while existing case and whitespace similarity remains', async () => {
  const store = new MemorySupportTicketStore(options());
  const first = await store.create(base, meta);
  const edited = await store.create({ ...base, name: 'Grace' }, meta);
  assert.equal(edited.duplicate, false);
  assert.equal(edited.ticket.name, 'Grace');
  assert.notEqual(edited.ticket.id, first.ticket.id);
  const retry = await store.create({ ...base, email: ' ADA@EXAMPLE.COM ', description: 'CANNOT  CONNECT WALLET.' }, meta);
  assert.equal(retry.duplicate, true);
  assert.equal(retry.ticket.id, first.ticket.id);
});

test('wallet changes cannot bypass idempotency conflicts or the existing quota', async () => {
  const store = new MemorySupportTicketStore({ ...options(), rateLimit: { max: 2, windowMs: 60_000 } });
  await store.create({ ...base, wallet_address: wallets[1], idempotency_key: 'fixed' }, meta);
  await assert.rejects(store.create({ ...base, wallet_address: wallets[2], idempotency_key: 'fixed' }, meta), { code: 'IDEMPOTENCY_CONFLICT' });
  const second = await store.create({ ...base, wallet_address: wallets[2], idempotency_key: 'new' }, meta);
  assert.equal(second.duplicate, false);
  await assert.rejects(store.create(base, meta), { code: 'RATE_LIMITED' });
  assert.equal(store.tickets.size, 2);
});
