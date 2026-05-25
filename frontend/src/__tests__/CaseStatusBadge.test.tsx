import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { CaseStatusBadge } from '../components/ui/CaseStatusBadge';

describe('CaseStatusBadge', () => {
  it('renders the human label for a status', () => {
    render(<CaseStatusBadge status="physician_review" />);
    expect(screen.getByText('Physician review')).toBeInTheDocument();
  });

  it('applies the status color token', () => {
    render(<CaseStatusBadge status="paid" />);
    const badge = screen.getByText('Paid');
    expect(badge.className).toContain('bg-emerald-200');
    expect(badge.className).toContain('font-semibold');
  });

  it('merges a caller className', () => {
    render(<CaseStatusBadge status="intake" className="ml-2" />);
    expect(screen.getByText('Intake').className).toContain('ml-2');
  });
});
