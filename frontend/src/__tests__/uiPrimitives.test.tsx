// SectionCard + Disclosure primitives (2026-06-16) — the calm/neutral consistency layer for the
// Overview story sections. Lock the behavior the rest of the restructure depends on.
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { SectionCard } from '../components/ui/SectionCard';
import { Disclosure } from '../components/ui/Disclosure';

describe('SectionCard', () => {
  it('renders the title, the status-chip slot, and the children', () => {
    render(
      <SectionCard title="Assessment" status={<span>Weak</span>}>
        <p>body</p>
      </SectionCard>,
    );
    expect(screen.getByRole('heading', { name: 'Assessment' })).toBeInTheDocument();
    expect(screen.getByText('Weak')).toBeInTheDocument();
    expect(screen.getByText('body')).toBeInTheDocument();
  });

  it('renders chrome-less (no title/status) without a heading', () => {
    render(<SectionCard><p>just body</p></SectionCard>);
    expect(screen.getByText('just body')).toBeInTheDocument();
    expect(screen.queryByRole('heading')).not.toBeInTheDocument();
  });
});

describe('Disclosure', () => {
  it('collapsed by default: children hidden, aria-expanded=false', () => {
    render(<Disclosure label="Details"><p>secret</p></Disclosure>);
    expect(screen.queryByText('secret')).not.toBeInTheDocument();
    expect(screen.getByRole('button')).toHaveAttribute('aria-expanded', 'false');
  });

  it('toggles open on click: children appear, aria-expanded=true, openLabel applies', () => {
    render(<Disclosure label="Details" openLabel="Hide details"><p>secret</p></Disclosure>);
    fireEvent.click(screen.getByRole('button'));
    expect(screen.getByText('secret')).toBeInTheDocument();
    expect(screen.getByRole('button')).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('button')).toHaveTextContent('Hide details');
  });

  it('defaultOpen renders expanded', () => {
    render(<Disclosure label="Details" defaultOpen><p>shown</p></Disclosure>);
    expect(screen.getByText('shown')).toBeInTheDocument();
  });
});
