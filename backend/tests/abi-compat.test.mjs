import assert from 'node:assert/strict';
import { test, describe } from 'node:test';
import {
  verifyRuntimeAbiCompatibility,
  AbiCompatibilityError,
} from '../src/services/contractGuard.js';
import { DripPoolContractClient } from '../src/generated/drip-pool-client.js';
import { decodeDripPoolEvent } from '../src/generated/drip-pool-events.js';

describe('ABI Compatibility & Contract Guard (Issue #77)', () => {
  const mockPin = {
    contractName: 'drip-pool',
    interfaceVersion: '1.0.0',
    wasmHash: 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2',
    specHash: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    networkPassphrase: 'Test SDF Network ; September 2015',
    generatedAt: new Date().toISOString(),
  };

  test('passes runtime verification when live WASM hash and network match pin', () => {
    const res = verifyRuntimeAbiCompatibility(
      mockPin.wasmHash,
      mockPin.networkPassphrase,
      mockPin
    );
    assert.equal(res.compatible, true);
    assert.ok(res.detail.includes('v1.0.0'));
  });

  test('throws AbiCompatibilityError on network passphrase mismatch', () => {
    assert.throws(
      () => verifyRuntimeAbiCompatibility(mockPin.wasmHash, 'Wrong Network', mockPin),
      (err) => err instanceof AbiCompatibilityError && err.code === 'NETWORK_MISMATCH'
    );
  });

  test('throws AbiCompatibilityError on WASM hash mismatch', () => {
    assert.throws(
      () => verifyRuntimeAbiCompatibility('00000000000000000000000000000000', mockPin.networkPassphrase, mockPin),
      (err) => err instanceof AbiCompatibilityError && err.code === 'WASM_HASH_MISMATCH'
    );
  });

  test('encodes typed contract client calls cleanly', () => {
    const client = new DripPoolContractClient(
      'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4',
      mockPin.networkPassphrase
    );

    const xdr = client.encodeDeposit({ vaultId: 'v-42', user: 'GUSER', amount: '500' });
    assert.equal(xdr, 'xdr:deposit:v-42:GUSER:500');
  });

  test('decodes raw Soroban events into typed structures', () => {
    const raw = {
      topicXdr: ['AAAAEgAAAAZEZXBvc2l0'],
      valueXdr: 'AAAAEw==',
    };
    const decoded = decodeDripPoolEvent(raw);
    assert.equal(decoded.eventType, 'Deposit');
  });
});
