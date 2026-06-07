// Binds the vendored REAL retrieve() (flatratenexus 1b23907) to live clients: an advisory_ro pg pool +
// a Bedrock client (Titan-v2 query embedding). Swaps in for the stub with zero interface change.
//
// The vendored module is CommonJS and reads its data files (intent_recipes / bva_condition_map / atlas)
// by __dirname-relative path, so it must NOT be bundled — it's loaded at RUNTIME from the copied vendor
// tree (the api Lambda commandHook copies backend/src/advisory/vendor -> <task>/advisory-vendor). Loading
// via createRequire with an ABSOLUTE entry is format-agnostic (works whether esbuild emits CJS or ESM)
// and avoids import.meta.url; absolute requires ignore the createRequire base.

import { createRequire } from 'node:module';
import path from 'node:path';
import { Pool } from 'pg';
import { BedrockRuntimeClient } from '@aws-sdk/client-bedrock-runtime';
import type { RetrieveFn, RetrievalInput, RetrievalResult } from './retrieveContract.js';

const VENDOR_DIR = process.env.ADVISORY_VENDOR_DIR ?? 'advisory-vendor';

type VendoredRetrieve = (input: RetrievalInput, clients: unknown) => Promise<RetrievalResult>;

function loadVendoredRetrieve(): VendoredRetrieve {
  const req = createRequire(path.join(process.cwd(), '_advisory_require_base.cjs'));
  const entry = path.join(process.cwd(), VENDOR_DIR, 'app', 'services', 'advisory', 'retrieve.js');
  const mod = req(entry) as { retrieve: VendoredRetrieve };
  return mod.retrieve;
}

let _retrieve: VendoredRetrieve | null = null;
let _pool: Pool | null = null;
let _bedrock: BedrockRuntimeClient | null = null;

// True only when the advisory_ro DB URL is wired — otherwise the route falls back to the stub (so dev /
// tests without the live cabinet still work).
export function realRetrieveAvailable(): boolean {
  const url = process.env.ADVISORY_RO_DATABASE_URL;
  return typeof url === 'string' && url.length > 0;
}

// The real retrieve, bound to the advisory_ro pool (SELECT-only identity) + the Titan bedrock client.
// Clients are lazily created on first call (cold-start friendly; the pool persists across invocations).
export const realRetrieve: RetrieveFn = (input) => {
  if (_retrieve === null) _retrieve = loadVendoredRetrieve();
  if (_pool === null) {
    _pool = new Pool({ connectionString: process.env.ADVISORY_RO_DATABASE_URL, max: 2, idleTimeoutMillis: 30_000 });
  }
  if (_bedrock === null) _bedrock = new BedrockRuntimeClient({});
  return _retrieve(input, { pgClient: _pool, bedrockClient: _bedrock });
};
