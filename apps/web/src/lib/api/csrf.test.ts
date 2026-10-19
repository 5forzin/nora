import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const incoming = vi.hoisted(() => ({ cookies: [] as Array<{ name: string; value: string }> }));
vi.mock('next/headers', () => ({ cookies: async () => ({ getAll: () => incoming.cookies }) }));

import { apiRequestHeaders } from './csrf';

const BASE = 'https://api.test.invalid';
const fetchMock = vi.fn<typeof fetch>();

beforeEach(() => {
  incoming.cookies = [];
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

describe('server CSRF transport', () => {
  it('forwards the incoming session and token only to the API request', async () => {
    incoming.cookies = [
      { name: 'nora_access', value: 'session-a' },
      { name: 'XSRF-TOKEN', value: 'csrf-a' },
    ];
    expect(await apiRequestHeaders(BASE, '/tasks/task-a', 'PATCH')).toEqual({
      Cookie: 'nora_access=session-a; XSRF-TOKEN=csrf-a', 'X-XSRF-TOKEN': 'csrf-a',
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each(['GET', 'HEAD'])('binds billed semantic search to the token for %s', async (method) => {
    const headers = await apiRequestHeaders(BASE, '/meetings/search?q=renewal', method, {
      Cookie: 'nora_access=session; XSRF-TOKEN=csrf-search',
    });
    expect(headers['X-XSRF-TOKEN']).toBe('csrf-search');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('bootstraps a missing token without losing the original session cookies', async () => {
    incoming.cookies = [{ name: 'nora_access', value: 'session-a' }, { name: 'nora_refresh', value: 'refresh-a' }];
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ token: 'csrf-new', headerName: 'X-XSRF-TOKEN' }), {
      headers: { 'Set-Cookie': 'XSRF-TOKEN=csrf-new; Path=/; HttpOnly; Secure; SameSite=Lax' },
    }));
    const headers = await apiRequestHeaders(BASE, '/meetings/search?q=renewal');
    expect(fetchMock).toHaveBeenCalledWith(`${BASE}/auth/csrf`, expect.objectContaining({
      headers: { Cookie: 'nora_access=session-a; nora_refresh=refresh-a', Accept: 'application/json' },
      cache: 'no-store', redirect: 'error', signal: expect.any(AbortSignal),
    }));
    expect(headers).toEqual({
      Cookie: 'nora_access=session-a; nora_refresh=refresh-a; XSRF-TOKEN=csrf-new',
      'X-XSRF-TOKEN': 'csrf-new',
    });
    expect(incoming.cookies).toHaveLength(2);
  });

  it('does not share a token between different incoming sessions', async () => {
    const a = await apiRequestHeaders(BASE, '/tasks', 'POST', { Cookie: 'nora_access=a; XSRF-TOKEN=csrf-a' });
    const b = await apiRequestHeaders(BASE, '/tasks', 'POST', { Cookie: 'nora_access=b; XSRF-TOKEN=csrf-b' });
    expect(a['X-XSRF-TOKEN']).toBe('csrf-a');
    expect(b['X-XSRF-TOKEN']).toBe('csrf-b');
  });

  it('does not bootstrap a bearer-only native request or an ordinary read', async () => {
    expect(await apiRequestHeaders(BASE, '/tasks', 'POST', { Authorization: 'Bearer native' }))
      .toEqual({ authorization: 'Bearer native' });
    expect(await apiRequestHeaders(BASE, '/meetings', 'GET', { Cookie: 'nora_access=session' }))
      .toEqual({ Cookie: 'nora_access=session' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects an unbound bootstrap response instead of submitting a write', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ token: 'csrf-new', headerName: 'X-XSRF-TOKEN' })));
    await expect(apiRequestHeaders(BASE, '/tasks', 'POST', { Cookie: 'nora_access=session' })).rejects.toThrow();
  });
});
