import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LetterEditor } from '../components/LetterEditor';

// Guided Revision UI (2026-06-13): stub window.getSelection so a mouseup on the editor reports a
// chosen passage. The editor only forwards a selection that is a VERBATIM substring of txt and lives
// inside the editor root (what the guided-revision backend can anchor).
function stubSelection(editor: HTMLElement, picked: string, opts: { collapsed?: boolean; inside?: boolean } = {}) {
  const inside = opts.inside ?? true;
  const node = inside ? editor.firstChild ?? editor : document.createElement('div'); // detached → not contained by editor
  vi.spyOn(window, 'getSelection').mockReturnValue({
    isCollapsed: opts.collapsed ?? false,
    rangeCount: picked.length > 0 ? 1 : 0,
    anchorNode: node,
    focusNode: node,
    toString: () => picked,
  } as unknown as Selection);
}

describe('LetterEditor', () => {
  it('EDITABLE mode preserves the literal **bold** markers (lossless round-trip)', () => {
    render(<LetterEditor txt="This is **bold** text." lockedRanges={[]} mode="editable" zoom={1} onChange={vi.fn()} />);
    const editor = screen.getByRole('textbox');
    // Raw text in editable mode → the ** markers survive in the DOM text, so reading the
    // editor back (innerText) is lossless. (Rendering <strong> here would drop them on save.)
    expect(editor.textContent).toContain('**bold**');
    expect(editor.querySelector('strong')).toBeNull();
    expect(editor).toHaveAttribute('contenteditable', 'true');
    expect(editor).toHaveAttribute('spellcheck', 'true');
  });

  it('READONLY mode renders bold (no asterisks shown) and is not editable', () => {
    render(<LetterEditor txt="This is **bold** text." lockedRanges={[]} mode="readonly" zoom={1} onChange={vi.fn()} />);
    const editor = screen.getByRole('textbox');
    expect(screen.getByText('bold')).toHaveClass('font-bold');
    expect(editor.textContent).not.toContain('**');
    expect(editor).toHaveAttribute('contenteditable', 'false');
  });

  it('renders locked regions greyed and non-editable', () => {
    render(<LetterEditor txt="Open Locked Open" lockedRanges={[{ start: 5, end: 11, label: 'signature' }]} mode="editable" zoom={1} onChange={vi.fn()} />);
    const locked = screen.getByText('Locked');
    expect(locked).toHaveClass('text-slate-500');
    expect(locked).toHaveAttribute('contenteditable', 'false');
  });

  describe('Guided Revision passage capture', () => {
    afterEach(() => vi.restoreAllMocks());

    it('reports a verbatim selection inside the editor as the passage', () => {
      const onSelectPassage = vi.fn();
      render(<LetterEditor txt="The veteran's lumbar strain is secondary." lockedRanges={[]} mode="editable" zoom={1} onChange={vi.fn()} onSelectPassage={onSelectPassage} />);
      const editor = screen.getByRole('textbox');
      stubSelection(editor, 'lumbar strain');
      fireEvent.mouseUp(editor);
      expect(onSelectPassage).toHaveBeenLastCalledWith('lumbar strain');
    });

    it('reports null for a non-verbatim selection (not a substring of the letter)', () => {
      const onSelectPassage = vi.fn();
      render(<LetterEditor txt="The veteran's lumbar strain is secondary." lockedRanges={[]} mode="editable" zoom={1} onChange={vi.fn()} onSelectPassage={onSelectPassage} />);
      const editor = screen.getByRole('textbox');
      stubSelection(editor, 'text that is not in the letter');
      fireEvent.mouseUp(editor);
      expect(onSelectPassage).toHaveBeenLastCalledWith(null);
    });

    it('reports null for a collapsed selection', () => {
      const onSelectPassage = vi.fn();
      render(<LetterEditor txt="The veteran's lumbar strain is secondary." lockedRanges={[]} mode="editable" zoom={1} onChange={vi.fn()} onSelectPassage={onSelectPassage} />);
      const editor = screen.getByRole('textbox');
      stubSelection(editor, '', { collapsed: true });
      fireEvent.mouseUp(editor);
      expect(onSelectPassage).toHaveBeenLastCalledWith(null);
    });
  });
});
