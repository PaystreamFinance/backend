/**
 * Postinstall verification for Lighter FFI binaries.
 * Checks that the correct platform-specific binaries exist.
 * Warns if missing — does not build.
 */

import { existsSync } from "fs";
import { resolve } from "path";

const FFI_DIR = resolve(import.meta.dir, "../../packages/perps/lighter/ffi");

const platform = process.platform;
const arch = process.arch;

interface BinaryCheck {
  file: string;
  label: string;
}

function getRequiredBinaries(): BinaryCheck[] {
  if (platform === "darwin" && arch === "arm64") {
    return [
      { file: "lighter-signer-darwin-arm64.dylib", label: "Signer (macOS arm64)" },
      { file: "lighter-wrapper.dylib", label: "Wrapper (macOS arm64)" },
    ];
  }

  if (platform === "linux" && arch === "x64") {
    return [
      { file: "lighter-signer-linux-amd64.so", label: "Signer (Linux x86_64)" },
      { file: "lighter-wrapper-linux-amd64.so", label: "Wrapper (Linux x86_64)" },
    ];
  }

  console.warn(`[lighter-ffi] Unsupported platform: ${platform}-${arch}, skipping verification`);
  return [];
}

const binaries = getRequiredBinaries();
let missing = false;

for (const { file, label } of binaries) {
  const fullPath = resolve(FFI_DIR, file);
  if (!existsSync(fullPath)) {
    console.warn(`[lighter-ffi] MISSING: ${label} — ${file}`);
    console.warn(`  Run: bash scripts/build-lighter-ffi.sh`);
    missing = true;
  }
}

if (!missing && binaries.length > 0) {
  console.log(`[lighter-ffi] All binaries present for ${platform}-${arch}`);
}
