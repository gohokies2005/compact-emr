import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { BuildStatusFooter } from '../components/BuildStatusFooter';

describe('BuildStatusFooter', () => {
  it('renders the product name and the API mode', () => {
    render(<BuildStatusFooter />);
    expect(screen.getByText('Aegis')).toBeInTheDocument();
    expect(screen.getByText(/API/i)).toBeInTheDocument();
  });
});
