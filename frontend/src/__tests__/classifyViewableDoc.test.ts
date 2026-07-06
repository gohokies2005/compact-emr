import { describe, it, expect } from 'vitest';
import { classifyViewableDoc } from '../components/PdfViewerModal';

const d = (filename: string, contentType?: string) => ({ id: 'x', filename, contentType });

describe('classifyViewableDoc — picks the in-page renderer per file type', () => {
  it('classifies .docx by extension and MIME', () => {
    expect(classifyViewableDoc(d('report.docx'))).toBe('docx');
    expect(classifyViewableDoc(d('x', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'))).toBe('docx');
  });

  it('classifies legacy binary .doc separately (download fallback, not docx)', () => {
    expect(classifyViewableDoc(d('old.doc'))).toBe('doc');
    expect(classifyViewableDoc(d('x', 'application/msword'))).toBe('doc');
  });

  it('classifies text-like files as text', () => {
    for (const n of ['notes.txt', 'summary.md', 'data.csv', 'run.log', 'obj.json']) {
      expect(classifyViewableDoc(d(n))).toBe('text');
    }
    expect(classifyViewableDoc(d('x', 'text/plain'))).toBe('text');
  });

  it('classifies pdf + images (case-insensitive)', () => {
    expect(classifyViewableDoc(d('letter.pdf'))).toBe('pdf');
    expect(classifyViewableDoc(d('scan.PDF'))).toBe('pdf');
    expect(classifyViewableDoc(d('x', 'application/pdf'))).toBe('pdf');
    expect(classifyViewableDoc(d('xray.jpg'))).toBe('image');
    expect(classifyViewableDoc(d('front.JPEG'))).toBe('image');
    expect(classifyViewableDoc(d('x', 'image/png'))).toBe('image');
  });

  it('extension WINS over a generic octet-stream content-type (uploads are often octet-stream)', () => {
    expect(classifyViewableDoc(d('report.docx', 'application/octet-stream'))).toBe('docx');
    expect(classifyViewableDoc(d('notes.txt', 'application/octet-stream'))).toBe('text');
    expect(classifyViewableDoc(d('letter.pdf', 'application/octet-stream'))).toBe('pdf');
  });

  it('unknown types fall back to other (clear download, not a silent save)', () => {
    expect(classifyViewableDoc(d('archive.zip'))).toBe('other');
    expect(classifyViewableDoc(d('noext'))).toBe('other');
  });
});
