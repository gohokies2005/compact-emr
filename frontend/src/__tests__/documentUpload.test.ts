import { describe, expect, it } from 'vitest';
import { ACCEPT_ATTR, classifyEntry, inferContentType, isJunkPath, isZip, extensionOf, MAX_BYTES, uploadErrorReason } from '../routes/veterans/documentUpload';

describe('documentUpload helpers', () => {
  it('infers contentType from extension when MIME is empty', () => {
    expect(inferContentType('scan.pdf')).toBe('application/pdf');
    expect(inferContentType('photo.JPG')).toBe('image/jpeg');
    expect(inferContentType('note.docx')).toBe('application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    expect(inferContentType('archive.zip')).toBeNull();
    expect(inferContentType('noext')).toBeNull();
  });

  it('prefers an explicit allowed MIME, ignores a disallowed MIME', () => {
    expect(inferContentType('x.pdf', 'application/pdf')).toBe('application/pdf');
    expect(inferContentType('x.pdf', 'application/zip')).toBe('application/pdf'); // disallowed MIME falls back to ext
    expect(inferContentType('notes.txt')).toBe('text/plain'); // .txt is supported (pure text)
    expect(inferContentType('x.exe', 'application/octet-stream')).toBeNull();
  });

  it('flags junk paths', () => {
    expect(isJunkPath('__MACOSX/foo.pdf')).toBe(true);
    expect(isJunkPath('docs/__MACOSX/foo.pdf')).toBe(true);
    expect(isJunkPath('.DS_Store')).toBe(true);
    expect(isJunkPath('Thumbs.db')).toBe(true);
    expect(isJunkPath('.hidden.pdf')).toBe(true);
    expect(isJunkPath('folder/')).toBe(true);
    expect(isJunkPath('records/str.pdf')).toBe(false);
  });

  it('extensionOf handles paths and dotfiles', () => {
    expect(extensionOf('a/b/c.PDF')).toBe('pdf');
    expect(extensionOf('.DS_Store')).toBe('');
    expect(extensionOf('noext')).toBe('');
  });

  it('classifies a good file as uploadable with basename + contentType', () => {
    const r = classifyEntry({ path: 'records/STR-2003.pdf', sizeBytes: 1234 });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.candidate.path).toBe('STR-2003.pdf');
      expect(r.candidate.contentType).toBe('application/pdf');
      expect(r.candidate.sizeBytes).toBe(1234);
    }
  });

  it('rejects directories, junk, unsupported types and oversized files', () => {
    expect(classifyEntry({ path: 'folder/', sizeBytes: 0, isDir: true })).toMatchObject({ ok: false, reason: 'directory_or_junk' });
    expect(classifyEntry({ path: '__MACOSX/x.pdf', sizeBytes: 1 })).toMatchObject({ ok: false, reason: 'directory_or_junk' });
    expect(classifyEntry({ path: 'virus.exe', sizeBytes: 1 })).toMatchObject({ ok: false, reason: 'unsupported_type' });
    expect(classifyEntry({ path: 'huge.pdf', sizeBytes: MAX_BYTES + 1 })).toMatchObject({ ok: false, reason: 'too_large' });
  });

  it('surfaces the real upload failure reason instead of a generic message', () => {
    // API 400 from presign/record (the most common silent failure: unsupported type, too large, bad key)
    expect(uploadErrorReason({ response: { status: 400, data: { error: { code: 'unsupported_content_type', message: 'Only PDF, JPG, PNG, DOC, and DOCX uploads are supported.' } } } }))
      .toBe('Only PDF, JPG, PNG, DOC, and DOCX uploads are supported.');
    // 403 mapped to ForbiddenError (no body)
    expect(uploadErrorReason({ name: 'ForbiddenError', message: 'Forbidden' }))
      .toMatch(/permission denied/i);
    // S3 PUT network/CORS failure (no response)
    expect(uploadErrorReason({ code: 'ERR_NETWORK', message: 'Network Error' }))
      .toMatch(/network\/CORS/i);
    // bare Error fallback
    expect(uploadErrorReason(new Error('boom'))).toBe('boom');
    // last-resort fallback
    expect(uploadErrorReason(undefined)).toBe('unexpected error');
  });

  it('keeps the file-picker accept attr in sync with the JS validation — .txt must stay in BOTH', () => {
    // Regression guard (Package 2/3 fold, 2026-06-11): classifyEntry accepted .txt while the picker's
    // accept attr omitted it, so the OS dialog greyed out files the upload path could handle.
    expect(ACCEPT_ATTR).toContain('.txt');
    expect(ACCEPT_ATTR).toContain('text/plain');
    expect(inferContentType('summary.txt')).toBe('text/plain');
    // Every extension the picker advertises (except .zip, which is expanded client-side) must classify.
    for (const ext of ['.pdf', '.jpg', '.jpeg', '.png', '.doc', '.docx', '.txt']) {
      expect(ACCEPT_ATTR).toContain(ext);
      expect(inferContentType(`file${ext}`)).not.toBeNull();
    }
  });

  it('detects zip files by MIME or extension', () => {
    expect(isZip({ name: 'records.zip' })).toBe(true);
    expect(isZip({ name: 'records.ZIP' })).toBe(true);
    expect(isZip({ name: 'x', type: 'application/zip' })).toBe(true);
    expect(isZip({ name: 'x', type: 'application/x-zip-compressed' })).toBe(true);
    expect(isZip({ name: 'scan.pdf', type: 'application/pdf' })).toBe(false);
  });
});
