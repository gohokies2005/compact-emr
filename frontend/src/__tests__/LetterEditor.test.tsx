import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { LetterEditor } from '../components/LetterEditor';

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
});
