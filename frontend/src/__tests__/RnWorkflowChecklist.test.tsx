import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { RnWorkflowChecklist } from '../components/RnWorkflowChecklist';

function renderChecklist(props: { veteranId?: string; caseId?: string } = {}) {
  render(
    <MemoryRouter>
      <RnWorkflowChecklist {...props} />
    </MemoryRouter>,
  );
}

describe('RnWorkflowChecklist', () => {
  it('renders the four workflow steps', () => {
    renderChecklist();
    expect(screen.getByText('1. Open veteran chart')).toBeInTheDocument();
    expect(screen.getByText('2. Complete RN file review')).toBeInTheDocument();
    expect(screen.getByText('3. Send to Drafter')).toBeInTheDocument();
    expect(screen.getByText('4. Physician review')).toBeInTheDocument();
  });

  it('links to the specific veteran and case when ids are provided', () => {
    renderChecklist({ veteranId: 'VET-1', caseId: 'CASE-1' });
    expect(screen.getByRole('link', { name: '1. Open veteran chart' })).toHaveAttribute(
      'href',
      '/veterans/VET-1',
    );
    expect(screen.getByRole('link', { name: '2. Complete RN file review' })).toHaveAttribute(
      'href',
      '/rn',
    );
    expect(screen.getByRole('link', { name: '3. Send to Drafter' })).toHaveAttribute(
      'href',
      '/cases/CASE-1',
    );
    expect(screen.getByRole('link', { name: '4. Physician review' })).toHaveAttribute(
      'href',
      '/p/queue',
    );
  });

  it('falls back to index routes when no ids are provided', () => {
    renderChecklist();
    expect(screen.getByRole('link', { name: '1. Open veteran chart' })).toHaveAttribute(
      'href',
      '/veterans',
    );
    expect(screen.getByRole('link', { name: '3. Send to Drafter' })).toHaveAttribute(
      'href',
      '/cases',
    );
  });
});
