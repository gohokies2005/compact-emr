import { describe, expect, it } from 'vitest';
import { escapeCsvField, rowsToCsv } from '../lib/csv';

describe('csv', () => {
  it('escapes only fields that need it', () => {
    expect(escapeCsvField('plain')).toBe('plain');
    expect(escapeCsvField('has,comma')).toBe('"has,comma"');
    expect(escapeCsvField('has"quote')).toBe('"has""quote"'); // " -> "" and wrapped
    expect(escapeCsvField('line\nbreak')).toBe('"line\nbreak"');
    expect(escapeCsvField(null)).toBe('');
    expect(escapeCsvField(undefined)).toBe('');
    expect(escapeCsvField(0)).toBe('0');
    expect(escapeCsvField(42)).toBe('42');
  });

  it('builds a BOM-prefixed, CRLF-joined CSV with a header row', () => {
    const csv = rowsToCsv(['Name', 'Note'], [['Smith, J', 'said "hi"'], ['Doe', null]]);
    expect(csv.charCodeAt(0)).toBe(0xfeff); // UTF-8 BOM for Excel
    const body = csv.slice(1);
    expect(body).toBe('Name,Note\r\n"Smith, J","said ""hi"""\r\nDoe,');
  });
});
