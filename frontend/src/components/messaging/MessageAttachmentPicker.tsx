import { useRef, useState } from 'react';
import { classifyEntry, MAX_BYTES } from '../../routes/veterans/documentUpload';
import { uploadAndRegisterAttachment } from '../../api/messaging';

// Staged attachment picker shared by Compose + the inline ReplyComposer. File input + removable chips.
// On add, each file is validated with the documentUpload classifier, then presign->PUT->register runs
// immediately so the parent only ever holds finalized attachmentIds. `uploading` count lets the parent
// disable Send while any upload is pending.
export interface StagedAttachment {
  readonly attachmentId: string;
  readonly filename: string;
  readonly sizeBytes: number;
}

export function MessageAttachmentPicker({
  staged,
  onChange,
  onUploadingChange,
  disabled,
}: {
  readonly staged: readonly StagedAttachment[];
  readonly onChange: (next: readonly StagedAttachment[]) => void;
  readonly onUploadingChange?: (uploading: boolean) => void;
  readonly disabled?: boolean;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [pending, setPending] = useState(0);
  const [error, setError] = useState<string | null>(null);

  function setPendingCount(updater: (n: number) => number) {
    setPending((prev) => {
      const next = updater(prev);
      onUploadingChange?.(next > 0);
      return next;
    });
  }

  async function handleFiles(files: FileList | null) {
    if (!files || files.length === 0) return;
    setError(null);
    const accepted: StagedAttachment[] = [];
    for (const file of Array.from(files)) {
      const result = classifyEntry({ path: file.name, sizeBytes: file.size, explicitType: file.type });
      if (!result.ok) {
        setError(
          result.reason === 'too_large'
            ? `${file.name} is over the ${Math.round(MAX_BYTES / (1024 * 1024))} MB limit.`
            : result.reason === 'unsupported_type'
              ? `${file.name} is not a supported file type.`
              : `${file.name} could not be attached.`,
        );
        continue;
      }
      setPendingCount((n) => n + 1);
      try {
        const registered = await uploadAndRegisterAttachment(file);
        accepted.push({ attachmentId: registered.attachmentId, filename: file.name, sizeBytes: file.size });
      } catch {
        setError(`${file.name} failed to upload. Please retry.`);
      } finally {
        setPendingCount((n) => n - 1);
      }
    }
    if (accepted.length > 0) onChange([...staged, ...accepted]);
    if (inputRef.current) inputRef.current.value = '';
  }

  function remove(attachmentId: string) {
    onChange(staged.filter((s) => s.attachmentId !== attachmentId));
  }

  return (
    <div>
      <div className="flex items-center gap-2">
        <input
          ref={inputRef}
          type="file"
          multiple
          className="hidden"
          aria-label="Attach files"
          disabled={disabled}
          onChange={(e) => handleFiles(e.target.files)}
        />
        <button
          type="button"
          className="rounded border border-slate-200 bg-white px-2 py-1 text-xs text-slate-700 hover:bg-slate-50 disabled:opacity-50"
          disabled={disabled}
          onClick={() => inputRef.current?.click()}
        >
          📎 Attach files
        </button>
        {pending > 0 ? <span className="text-xs text-slate-500">Uploading {pending}…</span> : null}
      </div>
      {error ? <p className="mt-1 text-xs text-rose-600">{error}</p> : null}
      {staged.length > 0 ? (
        <div className="mt-2 flex flex-wrap gap-2">
          {staged.map((a) => (
            <span
              key={a.attachmentId}
              className="inline-flex items-center gap-1 rounded border border-slate-200 bg-white px-2 py-1 text-xs text-slate-700"
            >
              📎 {a.filename}
              <button
                type="button"
                aria-label={`Remove ${a.filename}`}
                className="text-slate-400 hover:text-rose-600"
                onClick={() => remove(a.attachmentId)}
              >
                ✕
              </button>
            </span>
          ))}
        </div>
      ) : null}
    </div>
  );
}
