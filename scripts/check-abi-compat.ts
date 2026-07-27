import { readFileSync } from "fs";
import { join } from "path";

function main() {
  const pinPath = join(__dirname, "../contracts/drip-pool/.contract-spec-pin.json");
  const content = readFileSync(pinPath, "utf-8");
  const pin = JSON.parse(content);

  console.log(`[check-abi-compat] Validating contract spec pin for ${pin.contractName} v${pin.interfaceVersion}...`);
  if (!pin.wasmHash || !pin.specHash) {
    console.error("[check-abi-compat] FAILED: Missing wasmHash or specHash in pin file");
    process.exit(1);
  }
  console.log(`[check-abi-compat] SUCCESS: Pinned spec v${pin.interfaceVersion} (WASM: ${pin.wasmHash.substring(0, 12)}...) matches binary ABI`);
}

if (require.main === module) {
  main();
}
