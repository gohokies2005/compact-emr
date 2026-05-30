import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { LetterLockedRange } from '../api/letter';

type LetterEditorMode = 'editable' | 'readonly';

interface LetterEditorProps {
  readonly txt: string;
  readonly lockedRanges: readonly LetterLockedRange[];
  readonly mode: LetterEditorMode;
  readonly zoom: number;
  readonly onChange: (txt: string) => void;
}

interface LetterPiece {
  readonly key: string;
  readonly text: string;
  readonly locked: boolean;
  readonly label?: string | null;
}

// Tailwind needs literal class strings (no dynamic font-size), so map zoom → a class.
const ZOOM_CLASSES: Record<string, string> = {
  '0.8': 'text-[13px] leading-[22px]',
  '0.9': 'text-[14px] leading-[25px]',
  '1': 'text-base leading-7',
  '1.1': 'text-[18px] leading-8',
  '1.2': 'text-[19px] leading-9',
  '1.3': 'text-[21px] leading-10',
  '1.4': 'text-[22px] leading-[44px]',
};

function zoomClass(zoom: number): string {
  const key = String(Math.round(zoom * 10) / 10);
  return ZOOM_CLASSES[key] ?? 'text-base leading-7';
}

function clampRange(range: LetterLockedRange, length: number): LetterLockedRange {
  return { ...range, start: Math.max(0, Math.min(range.start, length)), end: Math.max(0, Math.min(range.end, length)) };
}

function normalizeRanges(ranges: readonly LetterLockedRange[], length: number): readonly LetterLockedRange[] {
  return ranges.map((r) => clampRange(r, length)).filter((r) => r.end > r.start).sort((a, b) => a.start - b.start);
}

function splitIntoPieces(txt: string, lockedRanges: readonly LetterLockedRange[]): readonly LetterPiece[] {
  const ranges = normalizeRanges(lockedRanges, txt.length);
  const pieces: LetterPiece[] = [];
  let cursor = 0;
  ranges.forEach((range, index) => {
    if (range.start > cursor) pieces.push({ key: `open-${cursor}-${range.start}`, text: txt.slice(cursor, range.start), locked: false });
    pieces.push({ key: `locked-${index}-${range.start}-${range.end}`, text: txt.slice(range.start, range.end), locked: true, label: range.label ?? null });
    cursor = range.end;
  });
  if (cursor < txt.length) pieces.push({ key: `open-${cursor}-${txt.length}`, text: txt.slice(cursor), locked: false });
  if (pieces.length === 0) pieces.push({ key: 'empty', text: '', locked: false });
  return pieces;
}

// Pretty bold rendering (readonly view only). NEVER used in editable mode — rendering
// **x** as <strong>x</strong> and then reading innerText would strip the ** markers and
// silently lose all bold on save. In editable mode we render the RAW text so the round-trip
// (innerText) is lossless. A future rich editor (CodeMirror/ProseMirror) can show bold while
// editing; for now correctness > prettiness while editing.
function renderBoldText(text: string): ReactNode[] {
  return text.split(/(\*\*[^*]+\*\*)/g).map((part, index) =>
    part.startsWith('**') && part.endsWith('**') && part.length > 4
      ? <strong key={`b-${index}`} className="font-bold">{part.slice(2, -2)}</strong>
      : <span key={`s-${index}`}>{part}</span>,
  );
}

function getTextFromEditor(root: HTMLDivElement): string {
  const text = root.innerText;
  return text.endsWith('\n') ? text.slice(0, -1) : text;
}

function lockedSlicesChanged(original: string, next: string, lockedRanges: readonly LetterLockedRange[]): boolean {
  return normalizeRanges(lockedRanges, original.length).some((range) => original.slice(range.start, range.end) !== next.slice(range.start, range.end));
}

export function LetterEditor({ txt, lockedRanges, mode, zoom, onChange }: LetterEditorProps) {
  const editorRef = useRef<HTMLDivElement | null>(null);
  const lastGoodTextRef = useRef(txt);
  const [localText, setLocalText] = useState(txt);
  const [lockWarning, setLockWarning] = useState<string | null>(null);

  useEffect(() => {
    setLocalText(txt);
    lastGoodTextRef.current = txt;
  }, [txt]);

  const editable = mode === 'editable';
  const pieces = useMemo(() => splitIntoPieces(localText, lockedRanges), [localText, lockedRanges]);

  function handleInput() {
    if (editorRef.current === null || !editable) return;
    const nextText = getTextFromEditor(editorRef.current);
    if (lockedSlicesChanged(localText, nextText, lockedRanges)) {
      setLockWarning('Locked letter sections cannot be edited.');
      // Revert the DOM to the last good text.
      editorRef.current.innerText = lastGoodTextRef.current;
      return;
    }
    lastGoodTextRef.current = nextText;
    setLocalText(nextText);
    setLockWarning(null);
    onChange(nextText);
  }

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <div className="text-sm text-slate-500">Native spellcheck is enabled. Locked regions are greyed.</div>
        {lockWarning ? <div className="text-sm text-amber-700">{lockWarning}</div> : null}
      </div>
      <div className="overflow-auto rounded-lg border border-slate-200 bg-slate-100 p-6">
        <div
          ref={editorRef}
          role="textbox"
          aria-multiline="true"
          contentEditable={editable}
          suppressContentEditableWarning
          spellCheck
          onInput={handleInput}
          className={`mx-auto min-h-[900px] max-w-[816px] whitespace-pre-wrap rounded-sm bg-white px-20 py-16 font-['Times_New_Roman',Times,serif] text-slate-950 shadow-sm outline-none focus:ring-2 focus:ring-slate-300 ${zoomClass(zoom)}`}
        >
          {pieces.map((piece) => {
            // Editable: raw text (lossless innerText round-trip). Readonly: pretty bold.
            const content = editable ? piece.text : renderBoldText(piece.text);
            return piece.locked ? (
              <span key={piece.key} contentEditable={false} className="rounded bg-slate-100 text-slate-500" title={piece.label ?? 'Locked section'}>{content}</span>
            ) : (
              <span key={piece.key}>{content}</span>
            );
          })}
        </div>
      </div>
    </div>
  );
}
