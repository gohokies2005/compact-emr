// Process-wide BigInt JSON serialization.
//
// BigInt is NOT JSON-serializable by default: `JSON.stringify`/`res.json` throw
// "TypeError: Do not know how to serialize a BigInt" the instant any payload carries one.
// In this codebase `Document.sizeBytes` is a Prisma BigInt (schema.prisma), so ANY response
// that eager-loads documents (e.g. GET /cases/:id once a case has uploads) — and the drafter
// bundle's JSON.stringify — threw a silent 500. Caught 2026-05-27 in the live-path sweep
// (P0-1 case-load crash + P1-1 bundle build).
//
// Importing this module (for its side effect) installs a BigInt -> string serializer. The
// frontend already treats sizeBytes as a string, so this is consistent end to end. Import it
// FIRST, before anything that may serialize a payload.
(BigInt.prototype as unknown as { toJSON: () => string }).toJSON = function (this: bigint) {
  return this.toString();
};
