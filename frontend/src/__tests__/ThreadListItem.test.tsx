import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ThreadListItem } from '../routes/inbox/ThreadListPane';
import type { InboxThreadSummary } from '../api/messaging';
import type { SubDirectory } from '../components/messaging/directory';

vi.mock('../lib/date', () => ({ formatRelativeTime: (value: string) => value }));

const directory: SubDirectory = { 'rn-sub': { name: 'Nurse Joy', role: 'ops_staff' } };

function makeThread(overrides: Partial<InboxThreadSummary> = {}): InboxThreadSummary {
  return {
    threadId: 'thread-1',
    subject: 'Records question',
    caseId: null,
    lastMessageBody: 'Can you take a look?',
    lastMessageAt: '2026-05-25T12:00:00.000Z',
    lastAuthorSub: 'rn-sub',
    messageCount: 1,
    unread: false,
    ...overrides,
  };
}

describe('ThreadListItem', () => {
  it('applies unread styling (indigo accent + dot + bold subject) when unread', () => {
    render(<ThreadListItem thread={makeThread({ unread: true })} selected={false} directory={directory} onSelect={() => {}} />);
    const button = screen.getByRole('button');
    expect(button.className).toContain('border-l-indigo-500');
    expect(screen.getByLabelText('Unread')).toBeInTheDocument();
    const subject = screen.getByText('Records question');
    expect(subject.className).toContain('font-semibold');
  });

  it('does NOT apply unread styling when read', () => {
    render(<ThreadListItem thread={makeThread({ unread: false })} selected={false} directory={directory} onSelect={() => {}} />);
    const button = screen.getByRole('button');
    expect(button.className).toContain('border-l-transparent');
    expect(screen.queryByLabelText('Unread')).not.toBeInTheDocument();
    expect(screen.getByText('Records question').className).not.toContain('font-semibold');
  });

  it('renders a case chip when the thread is case-linked', () => {
    render(<ThreadListItem thread={makeThread({ caseId: 'CASE-42' })} selected={false} directory={directory} onSelect={() => {}} />);
    expect(screen.getByText('CASE-42')).toBeInTheDocument();
  });

  it('resolves the sender label from the directory', () => {
    render(<ThreadListItem thread={makeThread()} selected={false} directory={directory} onSelect={() => {}} />);
    expect(screen.getByText('Nurse Joy')).toBeInTheDocument();
  });
});
