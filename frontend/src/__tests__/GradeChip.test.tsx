import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { GradeChip } from '../components/ui/GradeChip';

describe('GradeChip', () => {
  it('shows the normal grade pill when not a synthesized floor', () => {
    render(<GradeChip grade="B+" />);
    expect(screen.getByText('Grade: B+')).toBeInTheDocument();
    expect(screen.queryByText(/Grade unavailable/)).toBeNull();
  });

  it('shows amber "grade unavailable" and HIDES the letter when synthesizedFloor is true', () => {
    render(<GradeChip grade="C" synthesizedFloor={true} reason="grader_threw" />);
    const chip = screen.getByText('Grade unavailable — needs review');
    expect(chip).toBeInTheDocument();
    expect(chip.className).toContain('bg-amber-100');
    // the silent C must NOT be shown
    expect(screen.queryByText('Grade: C')).toBeNull();
  });

  it('treats a falsy/absent synthesizedFloor as a normal grade (dormant until producer emits it)', () => {
    render(<GradeChip grade="A-" synthesizedFloor={null} />);
    expect(screen.getByText('Grade: A-')).toBeInTheDocument();
  });
});
