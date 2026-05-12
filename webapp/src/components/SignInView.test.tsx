import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SignInView } from './SignInView';
import {
  completeDevCallback,
  getAuthConfig,
  startGoogleAuth,
} from '../lib/api';

vi.mock('../lib/api', () => ({
  getAuthConfig: vi.fn(),
  startGoogleAuth: vi.fn(),
  completeDevCallback: vi.fn(),
}));

describe('SignInView', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getAuthConfig).mockResolvedValue({ devMode: false });
    vi.mocked(startGoogleAuth).mockRejectedValue(
      new Error('stop after startGoogleAuth'),
    );
    vi.mocked(completeDevCallback).mockResolvedValue();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('passes current route as returnTo when starting Google sign-in', async () => {
    render(
      <MemoryRouter initialEntries={['/app/talks/talk-123?view=full#latest']}>
        <SignInView onSignedIn={vi.fn()} />
      </MemoryRouter>,
    );

    const signInButton = await screen.findByRole('button', {
      name: 'Continue With Google',
    });
    fireEvent.click(signInButton);

    await waitFor(() =>
      expect(startGoogleAuth).toHaveBeenCalledWith({
        returnTo: '/app/talks/talk-123?view=full#latest',
      }),
    );
  });
});
