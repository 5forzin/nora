/** @vitest-environment jsdom */
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  router: { replace: vi.fn(), refresh: vi.fn() },
  getCurrentUser: vi.fn(),
  sharedRefresh: vi.fn(),
  clearLocalSession: vi.fn(),
}));
vi.mock('next/navigation', () => ({
  useRouter: () => mocks.router,
  useSearchParams: () => new URLSearchParams('next=%2Fchat%3Fs%3Dexisting'),
}));
vi.mock('@/lib/auth', () => ({ ...mocks, setSession: vi.fn() }));

import { AuthScreen } from './auth-screen';

beforeEach(() => { vi.clearAllMocks(); });
afterEach(cleanup);

describe('login session recovery', () => {
  it('labels the password separately from its recovery link', () => {
    mocks.getCurrentUser.mockReturnValue(null);
    render(<AuthScreen initialMode="login" />);
    expect(screen.getByLabelText('Senha', { exact: true }).getAttribute('id')).toBe('login-pw');
    expect(screen.getByRole('link', { name: 'Esqueci minha senha' }).getAttribute('href')).toBe('/auth/password/reset/request');
  });

  it('recovers an expired access cookie through the server before restoring the destination', async () => {
    mocks.getCurrentUser.mockReturnValue({ userId: 'demo' });
    mocks.sharedRefresh.mockResolvedValue({ ok: true, status: 200 });
    render(<AuthScreen initialMode="login" />);
    await waitFor(() => expect(mocks.router.replace).toHaveBeenCalledWith('/chat?s=existing'));
    expect(mocks.router.refresh).toHaveBeenCalledOnce();
  });

  it('clears rejected sessions without granting access from the display cookie', async () => {
    mocks.getCurrentUser.mockReturnValue({ userId: 'demo' });
    mocks.sharedRefresh.mockResolvedValue({ ok: false, status: 401 });
    render(<AuthScreen initialMode="login" />);
    await waitFor(() => expect(mocks.clearLocalSession).toHaveBeenCalledOnce());
    expect(mocks.router.replace).not.toHaveBeenCalled();
  });

  it('keeps the login form available when the network fails', async () => {
    mocks.getCurrentUser.mockReturnValue({ userId: 'demo' });
    mocks.sharedRefresh.mockResolvedValue({ ok: false, status: null });
    const screen = render(<AuthScreen initialMode="login" />);
    await waitFor(() => expect((screen.getByRole('button', { name: /^Entrar$/ }) as HTMLButtonElement).disabled).toBe(false));
    expect(mocks.clearLocalSession).not.toHaveBeenCalled();
    expect(mocks.router.replace).not.toHaveBeenCalled();
  });

  it('does not renew a signed-out visitor', () => {
    mocks.getCurrentUser.mockReturnValue(null);
    render(<AuthScreen initialMode="login" />);
    expect(mocks.sharedRefresh).not.toHaveBeenCalled();
  });
});
