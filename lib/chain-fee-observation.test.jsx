import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import GasPrioritySelector from '@/components/app/GasPrioritySelector';
import { buildStellarFeeEstimate, fetchStellarFeeStats } from '@/lib/chain-fee-adapters';

beforeEach(() => localStorage.clear());
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

const horizon = 'https://synthetic-horizon.example';
function read(payload) {
  const fetchImpl = vi.fn().mockResolvedValue({ ok: true, json: async () => payload });
  return fetchStellarFeeStats({ customHorizonUrl: horizon, fetchImpl });
}

describe('Horizon fee observation validity', () => {
  it.each([undefined, null, true, false, '', ' ', 'invalid', -1, 0, 1.5, '1.5', '1e2', [], {}, 9007199254740992])(
    'does not label an invalid base fee %j as a live observation', async (value) => {
      await expect(read({ last_ledger: '123', last_ledger_base_fee: value })).rejects.toThrow(/fee_stats/);
    },
  );
  it.each([undefined, null, true, false, '', ' ', 'invalid', -1, 0, 1.5, '1.5', '1e2', [], {}, 9007199254740992])(
    'does not claim provenance from an invalid ledger %j', async (value) => {
      await expect(read({ last_ledger: value, last_ledger_base_fee: '101' })).rejects.toThrow(/fee_stats/);
    },
  );
  it.each([[123, 101], ['123', '101']])('retains valid numeric/string observations', async (ledger, fee) => {
    const result = await read({ last_ledger: ledger, last_ledger_base_fee: fee });
    expect(result.baseFeeStroops).toBe(101);
    expect(result.sourceLedger).toBe('123');
    expect(result.fresh).toBe(true);
    expect(result.horizonUrl).toBe(horizon);
  });
  it('preserves the final stroop in the fee payload', () => {
    const result = buildStellarFeeEstimate({ baseFeeStroops: 101, sourceLedger: '123', fetchedAt: new Date() });
    expect(result.feeStroops).toBe(101);
    expect(result.estimatedNative).toBe(0.0000101);
    expect(result.feeBid).toBe('0.0000101 XLM');
  });
});

it('keeps malformed provider data visibly stale in the real selector and parent callback', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ last_ledger: '123' }) }));
  const onChange = vi.fn();
  render(<GasPrioritySelector customHorizonUrl={horizon} nativeBalance={1} onChange={onChange} />);
  await waitFor(() => expect(screen.getByTestId('refresh-fees-btn').disabled).toBe(false));
  await waitFor(() => expect(screen.getByTestId('metric-base-fee').textContent).toContain('100 stroops'));
  const result = onChange.mock.calls.at(-1)[0];
  expect(result.sourceLedger).toBe('fallback');
  expect(result.isStale).toBe(true);
  expect(result.payload.isStale).toBe(true);
  expect(globalThis.fetch).toHaveBeenCalledTimes(1);
});

it('shows all seven XLM decimal places for a valid live estimate', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ last_ledger: '123', last_ledger_base_fee: '101' }) }));
  const onChange = vi.fn();
  render(<GasPrioritySelector customHorizonUrl={horizon} nativeBalance={1} onChange={onChange} />);
  await waitFor(() => expect(screen.getByTestId('metric-base-fee').textContent).toContain('101 stroops'));
  expect(screen.getByTestId('tier-btn-medium').textContent).toContain('0.0000101 XLM');
  expect(onChange.mock.calls.at(-1)[0].payload.feeBid).toBe('0.0000101 XLM');
  expect(onChange.mock.calls.at(-1)[0].isStale).toBe(false);
});
