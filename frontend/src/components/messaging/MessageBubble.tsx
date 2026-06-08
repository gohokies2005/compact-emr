import { formatRelativeTime } from '../../lib/date';
import { getAttachmentDownloadUrl, type ThreadMessage } from '../../api/messaging';
import { roleClassName, senderLabel, type BubbleRole, type SubDirectory } from './directory';

// Reuses the CaseMessagesPanel role-color map + bubble markup, and the EmailLogPanel attachment
// download-chip style. Roles aren't carried per-message on a StaffMessage (the cross-role key is
// `sub`), so the bubble resolves a display name + role color from a caller-supplied directory (see
// ./directory.ts).

async function downloadAttachment(attachmentId: string) {
  try {
    const { data } = await getAttachmentDownloadUrl(attachmentId);
    window.open(data.downloadUrl, '_blank', 'noopener,noreferrer');
  } catch {
    window.alert('Could not open that attachment. Please retry.');
  }
}

export function MessageBubble({
  message,
  directory,
  readByLabel,
}: {
  readonly message: ThreadMessage;
  readonly directory: SubDirectory;
  readonly readByLabel?: string | undefined;
}) {
  const entry = directory[message.authorSub];
  const role: BubbleRole = entry?.role ?? 'unknown';
  return (
    <article className="rounded-lg border border-slate-200 bg-slate-50 p-4">
      <div className="flex flex-wrap items-center gap-2">
        <span className={`rounded-full border px-2.5 py-1 text-xs font-medium ${roleClassName(role)}`}>
          {senderLabel(message.authorSub, directory)}
        </span>
        <span className="text-xs text-slate-500">{formatRelativeTime(message.createdAt)}</span>
        {readByLabel ? <span className="text-xs text-slate-400">{readByLabel}</span> : null}
      </div>
      <p className="mt-3 whitespace-pre-wrap text-sm leading-6 text-slate-800">{message.body}</p>
      {message.attachments.length > 0 ? (
        <div className="mt-3 flex flex-wrap gap-2">
          {message.attachments.map((a) => (
            <button
              key={a.id}
              type="button"
              className="rounded border border-slate-200 bg-white px-2 py-1 text-xs text-indigo-600 hover:bg-indigo-50"
              onClick={() => downloadAttachment(a.id)}
            >
              📎 {a.filename}
            </button>
          ))}
        </div>
      ) : null}
    </article>
  );
}
