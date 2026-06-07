import { describe, it, expect } from 'vitest';
import { parseEmbeddedChunk, toVectorLiteral, CABINET_DDL, EMBEDDING_DIM } from '../advisory-loader.js';

const validEmbedding = (): number[] => Array<number>(EMBEDDING_DIM).fill(0.1);
const validLine = (over: Record<string, unknown> = {}): string =>
  JSON.stringify({ id: 'c1', text: 'a chunk', embedding: validEmbedding(), ...over });

describe('parseEmbeddedChunk', () => {
  it('parses a valid chunk with all fields', () => {
    const c = parseEmbeddedChunk(validLine({
      source: 'semantic', condition: 'OSA', library_path: 'osa/key_excerpts.md',
      title: 'T', citation: 'PMID:1', pmid: '1', citation_type: 'A2', letter_citable: false,
    }));
    expect(c.id).toBe('c1');
    expect(c.text).toBe('a chunk');
    expect(c.library_path).toBe('osa/key_excerpts.md');
    expect(c.letter_citable).toBe(false);
    expect(c.embedding).toHaveLength(EMBEDDING_DIM);
  });

  it('defaults letter_citable to true and optional fields to null', () => {
    const c = parseEmbeddedChunk(validLine());
    expect(c.letter_citable).toBe(true);
    expect(c.source).toBeNull();
    expect(c.pmid).toBeNull();
  });

  it('throws on invalid JSON', () => {
    expect(() => parseEmbeddedChunk('{not json')).toThrow(/not valid JSON/);
  });

  it('throws on missing id / text', () => {
    expect(() => parseEmbeddedChunk(JSON.stringify({ text: 'x', embedding: validEmbedding() }))).toThrow(/missing\/empty id/);
    expect(() => parseEmbeddedChunk(JSON.stringify({ id: 'c1', embedding: validEmbedding() }))).toThrow(/missing\/empty text/);
  });

  it('throws on wrong embedding dimension', () => {
    expect(() => parseEmbeddedChunk(validLine({ embedding: [0.1, 0.2] }))).toThrow(/1024-length array/);
  });

  it('throws on a non-finite embedding value', () => {
    const bad = validEmbedding();
    bad[5] = Number.NaN;
    expect(() => parseEmbeddedChunk(validLine({ embedding: bad }))).toThrow(/non-finite/);
  });
});

describe('toVectorLiteral', () => {
  it('formats a pgvector literal', () => {
    expect(toVectorLiteral([1, 2, 3, ...Array<number>(EMBEDDING_DIM - 3).fill(0)])).toMatch(/^\[1,2,3,/);
  });
  it('throws on wrong dimension', () => {
    expect(() => toVectorLiteral([1, 2, 3])).toThrow(/expected 1024 dims/);
  });
});

describe('CABINET_DDL', () => {
  it('creates the extension, table, HNSW index, both roles, and the SET-ROLE grants', () => {
    expect(CABINET_DDL).toMatch(/CREATE EXTENSION IF NOT EXISTS vector/);
    expect(CABINET_DDL).toMatch(/CREATE TABLE IF NOT EXISTS advisory\.ref_chunk/);
    expect(CABINET_DDL).toMatch(/USING hnsw \(embedding vector_cosine_ops\)/);
    expect(CABINET_DDL).toMatch(/CREATE ROLE advisory_ro NOLOGIN/);
    expect(CABINET_DDL).toMatch(/CREATE ROLE advisory_loader NOLOGIN/);
    expect(CABINET_DDL).toMatch(/GRANT SELECT ON advisory\.ref_chunk TO advisory_ro/);
    expect(CABINET_DDL).toMatch(/GRANT INSERT ON advisory\.ref_chunk TO advisory_loader/);
    expect(CABINET_DDL).toMatch(/GRANT advisory_ro, advisory_loader TO CURRENT_USER/);
  });
  it('grants advisory_ro NO write access on ref_chunk (read-only-by-architecture)', () => {
    expect(CABINET_DDL).not.toMatch(/GRANT[^;]*INSERT[^;]*TO advisory_ro/);
    expect(CABINET_DDL).not.toMatch(/GRANT[^;]*UPDATE[^;]*advisory_ro/);
    expect(CABINET_DDL).not.toMatch(/GRANT[^;]*DELETE[^;]*advisory_ro/);
  });
});
