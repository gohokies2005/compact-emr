import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Button } from '../ui/Button';
import { describeApiError } from '../../api/client';
import { sendMessage } from '../../api/messaging';
import { RecipientMultiSelect, type SelectedRecipient } from './RecipientMultiSelect';
import { CasePicker, type SelectedCase } from './CasePicker';
import { MessageAttachmentPicker, type StagedAttachment } from './MessageAttachmentPicker';

// Compose-new modal (frame mirrors QuickNotePopup/TransitionModal: fixed overlay + centered card +
// stop-propagation). Send is disabled until >=1 recipient + subject + body + no pending upload.
//
// Three modes:
//   - Inbox (default): free-form case link via the optional CasePicker (toggle OFF by default).
//   - Inbox opened from a chart: `initialCase` PRE-FILLS the case link but keeps the CasePicker visible,
//     so the default can be cleared or changed. Used so a message composed from the inbox after viewing a
//     chart defaults to that veteran's case without re-searching by name (Ryan 2026-07-22).
//   - Chart Messages tab: `lockedCase` pre-links the thread to that case and HIDES the CasePicker (the
//     case is non-editable here — every chart-composed thread is collaboration-scoped to this case).
//     `initialRecipients` seeds the recipient list (the case's assigned RN + physician).
export function ComposeMessageModal({
  onClose,
  onSent,
  lockedCase,
  initialCase,
  initialRecipients,
}: {
  readonly onClose: () => void;
  readonly onSent: (threadId: string) => void;
  readonly lockedCase?: SelectedCase;
  readonly initialCase?: SelectedCase;
  readonly initialRecipients?: readonly SelectedRecipient[];
}) {
  const qc = useQueryClient();
  const [recipients, setRecipients] = useState<readonly SelectedRecipient[]>(initialRecipients ?? []);
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [linkedCase, setLinkedCase] = useState<SelectedCase | null>(lockedCase ?? initialCase ?? null);
  const [attachments, setAttachments] = useState<readonly StagedAttachment[]>([]);
  const [uploading, setUploading] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const sendMutation = useMutation({
    mutationFn: () =>
      sendMessage({
        subject: subject.trim(),
        body: body.trim(),
        recipients: recipients.map((r) => r.send),
        ...(linkedCase ? { caseId: linkedCase.id } : {}),
        attachmentIds: attachments.map((a) => a.attachmentId),
      }),
    onSuccess: async (result) => {
      await qc.invalidateQueries({ queryKey: ['messages', 'inbox'] });
      await qc.invalidateQueries({ queryKey: ['messages', 'unread-count'] });
      onSent(result.threadId);
    },
    onError: (e: unknown) => setErrorMessage(`Message could not be sent — ${describeApiError(e)}`),
  });

  const hasRecipient = recipients.length > 0;
  const sendDisabled =
    !hasRecipient ||
    subject.trim().length === 0 ||
    body.trim().length === 0 ||
    body.length > 4000 ||
    uploading ||
    sendMutation.isPending;

  return (
    <div className="fixed inset-0 z-50 overflow-y-auto bg-slate-900/40 p-6" onClick={onClose}>
      <div className="mx-auto mt-16 max-w-2xl rounded-lg bg-white p-6 shadow-xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-base font-semibold text-slate-900">New message</h2>
          <button type="button" className="text-slate-400 hover:text-slate-600" aria-label="Close" onClick={onClose}>
            ✕
          </button>
        </div>

        <div className="mt-4 space-y-4">
          <div>
            <span className="mb-1 block text-sm font-medium text-slate-700">Recipients</span>
            <RecipientMultiSelect selected={recipients} onChange={setRecipients} />
          </div>

          <label className="block">
            <span className="mb-1 block text-sm font-medium text-slate-700">Subject</span>
            <input
              className="input"
              aria-label="Subject"
              value={subject}
              maxLength={200}
              onChange={(e) => {
                setSubject(e.target.value);
                setErrorMessage(null);
              }}
              placeholder="What's this about?"
            />
          </label>

          <label className="block">
            <span className="mb-1 block text-sm font-medium text-slate-700">Message</span>
            <textarea
              aria-label="Message body"
              value={body}
              onChange={(e) => {
                setBody(e.target.value);
                setErrorMessage(null);
              }}
              rows={6}
              maxLength={4000}
              className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-900 shadow-sm focus:border-slate-400 focus:outline-none focus:ring-2 focus:ring-slate-200"
              placeholder="Write your message…"
            />
            <span className="mt-1 block text-xs text-slate-500">{body.length}/4000</span>
          </label>

          {lockedCase ? (
            <div>
              <span className="mb-1 block text-sm font-medium text-slate-700">Linked case</span>
              <div className="flex items-center gap-2 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-700">
                <span className="inline-flex items-center rounded-full bg-slate-200 px-2 py-0.5 text-[10px] font-medium text-slate-600">
                  Locked
                </span>
                <span className="text-slate-900">{lockedCase.label}</span>
              </div>
            </div>
          ) : (
            <CasePicker value={linkedCase} onChange={setLinkedCase} />
          )}

          <MessageAttachmentPicker
            staged={attachments}
            onChange={setAttachments}
            onUploadingChange={setUploading}
            disabled={sendMutation.isPending}
          />

          {errorMessage ? (
            <div className="rounded-lg border border-rose-200 bg-rose-50 p-3 text-sm text-rose-700">{errorMessage}</div>
          ) : null}
        </div>

        <div className="mt-6 flex items-center justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            loading={sendMutation.isPending}
            disabled={sendDisabled}
            onClick={() => sendMutation.mutate()}
          >
            Send
          </Button>
        </div>
      </div>
    </div>
  );
}
