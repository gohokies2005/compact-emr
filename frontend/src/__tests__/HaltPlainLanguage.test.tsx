import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Mock the query hook so we can drive the confidence value directly (no QueryClient / network needed).
vi.mock('../hooks/useHaltExplanation', () => ({ useHaltExplanation: vi.fn() }));
import { useHaltExplanation } from '../hooks/useHaltExplanation';
import { HaltPlainLanguage } from '../components/HaltPlainLanguage';

const useHaltExplanationMock = vi.mocked(useHaltExplanation);

function seed(explanation: { summary: string; what_to_do: string; confidence: 'high' | 'medium' | 'low' } | null, isLoading = false) {
  useHaltExplanationMock.mockReturnValue({ explanation, isLoading });
}

beforeEach(() => { useHaltExplanationMock.mockReset(); });

describe('HaltPlainLanguage — confidence affordance (QA 2026-07-02 #5)', () => {
  it("shows '⚠ Verify before acting' when confidence is 'low'", () => {
    seed({ summary: 'S', what_to_do: 'W', confidence: 'low' });
    render(<HaltPlainLanguage caseId="C1" technicalDetail={<p>raw</p>} />);
    expect(screen.getByText(/Verify before acting/i)).toBeTruthy();
  });

  it("shows '⚠ Verify before acting' when confidence is 'medium'", () => {
    seed({ summary: 'S', what_to_do: 'W', confidence: 'medium' });
    render(<HaltPlainLanguage caseId="C1" technicalDetail={<p>raw</p>} />);
    expect(screen.getByText(/Verify before acting/i)).toBeTruthy();
  });

  it("shows NO verify affordance when confidence is 'high'", () => {
    seed({ summary: 'S', what_to_do: 'W', confidence: 'high' });
    render(<HaltPlainLanguage caseId="C1" technicalDetail={<p>raw</p>} />);
    expect(screen.getByText(/Why this paused/i)).toBeTruthy();
    expect(screen.queryByText(/Verify before acting/i)).toBeNull();
  });

  it('renders only the raw technical detail (no plain-language block) when the explainer is unavailable', () => {
    seed(null);
    render(<HaltPlainLanguage caseId="C1" technicalDetail={<p>raw fallback text</p>} />);
    expect(screen.getByText('raw fallback text')).toBeTruthy();
    expect(screen.queryByText(/Why this paused/i)).toBeNull();
  });
});
