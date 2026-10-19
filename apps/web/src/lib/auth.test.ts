/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as Auth from './auth';

const user = { userId: 'demo', tenantId: 'demo', email: 'demo@example.test', displayName: 'Demo' };
const fetchMock = vi.fn();
let auth: typeof Auth;

beforeEach(async () => {
  vi.useFakeTimers();
  vi.resetModules();
  sessionStorage.clear();
  document.cookie = 'nora_user=; Path=/; Max-Age=0';
  vi.stubGlobal('fetch', (url: string, options: RequestInit) => url.endsWith('/auth/csrf')
    ? Promise.resolve(new Response(JSON.stringify({ token: 'csrf-session', headerName: 'X-XSRF-TOKEN' })))
    : fetchMock(url, options));
  fetchMock.mockReset().mockResolvedValue(new Response(JSON.stringify({ expiresInSeconds: 900 }), { status: 200 }));
  auth = await import('./auth');
});

afterEach(() => {
  auth.cancelScheduledRefresh();
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('session renewal', () => {
  it('restores the original refresh deadline after a document reload', async () => {
    auth.setSession(user, 900);
    await vi.advanceTimersByTimeAsync(600_000);
    auth.cancelScheduledRefresh();
    vi.resetModules();
    auth = await import('./auth');
    auth.resumeSessionRefresh();
    await vi.advanceTimersByTimeAsync(119_999);
    expect(fetchMock).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledWith('https://api.test.invalid/auth/refresh', expect.objectContaining({ credentials: 'include' }));
  });

  it('renews a restored session with no stored deadline', async () => {
    document.cookie = `nora_user=${encodeURIComponent(JSON.stringify(user))}; Path=/`;
    auth.resumeSessionRefresh();
    auth.resumeSessionRefresh();
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('does not refresh a signed-out visitor', async () => {
    auth.resumeSessionRefresh();
    await vi.advanceTimersByTimeAsync(900_000);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('shares rotation between the timer and expired API requests', async () => {
    let resolve!: (response: Response) => void;
    fetchMock.mockImplementationOnce(() => new Promise<Response>((done) => { resolve = done; }));
    const a = auth.sharedRefresh();
    const b = auth.sharedRefresh();
    expect(a).toBe(b);
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock).toHaveBeenCalledOnce();
    resolve(new Response(JSON.stringify({ expiresInSeconds: 900 }), { status: 200 }));
    expect((await a).ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledWith('https://api.test.invalid/auth/refresh', expect.objectContaining({
      headers: { 'X-XSRF-TOKEN': 'csrf-session' }, credentials: 'include',
    }));
  });

  it('serializes refresh across documents when Web Locks are available', async () => {
    let release!: () => void;
    const lock = vi.fn((_name: string, callback: () => Promise<unknown>) => new Promise((resolve) => {
      release = () => { void callback().then(resolve); };
    }));
    vi.stubGlobal('navigator', { locks: { request: lock } });
    const pending = auth.sharedRefresh();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(lock).toHaveBeenCalledWith('nora:refresh', expect.any(Function));
    release();
    expect((await pending).ok).toBe(true);
  });

  it('retries a transient refresh failure without clearing the session', async () => {
    auth.setSession(user, 900);
    fetchMock.mockRejectedValueOnce(new TypeError('Network unavailable'));
    expect(await auth.runProactiveRefresh()).toBeNull();
    expect(auth.getCurrentUser()).toEqual(user);
    await vi.advanceTimersByTimeAsync(24_000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('clears the persisted schedule on logout', async () => {
    auth.setSession(user, 900);
    auth.clearLocalSession();
    expect(sessionStorage.getItem('nora:refresh-at')).toBeNull();
    await vi.advanceTimersByTimeAsync(900_000);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('binds logout to the current CSRF cookie', async () => {
    await auth.clearSession();
    expect(fetchMock).toHaveBeenCalledWith('https://api.test.invalid/auth/logout', expect.objectContaining({
      headers: { 'X-XSRF-TOKEN': 'csrf-session' }, credentials: 'include', method: 'POST',
    }));
  });
});
