/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const BASE = 'https://api.test.invalid';
const fetchMock = vi.fn<typeof fetch>();

beforeEach(() => {
  vi.resetModules();
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

function tokenResponse(token: string) {
  return new Response(JSON.stringify({ token, headerName: 'X-XSRF-TOKEN' }));
}

describe('browser CSRF transport', () => {
  it('shares an in-flight bootstrap but refetches after cookies may have changed', async () => {
    let release!: (response: Response) => void;
    fetchMock.mockImplementationOnce(() => new Promise<Response>((resolve) => { release = resolve; }));
    const { apiRequestHeaders } = await import('./csrf');
    const a = apiRequestHeaders(BASE, '/tasks', 'POST');
    const b = apiRequestHeaders(BASE, '/meetings/search?q=renewal', 'GET');
    expect(fetchMock).toHaveBeenCalledOnce();
    release(tokenResponse('csrf-a'));
    expect((await a)['X-XSRF-TOKEN']).toBe('csrf-a');
    expect((await b)['X-XSRF-TOKEN']).toBe('csrf-a');
    fetchMock.mockResolvedValueOnce(tokenResponse('csrf-b'));
    expect((await apiRequestHeaders(BASE, '/tasks', 'DELETE'))['X-XSRF-TOKEN']).toBe('csrf-b');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0][1]).toMatchObject({
      credentials: 'include', cache: 'no-store', redirect: 'error', signal: expect.any(AbortSignal),
    });
  });

  it('never copies server-only cookies into browser request headers', async () => {
    fetchMock.mockResolvedValue(tokenResponse('csrf-browser'));
    const { apiRequestHeaders } = await import('./csrf');
    const headers = await apiRequestHeaders(BASE, '/tasks', 'POST', { Cookie: 'nora_access=do-not-send', 'X-XSRF-TOKEN': 'stale' });
    expect(headers).toEqual({ 'X-XSRF-TOKEN': 'csrf-browser' });
    expect(fetchMock.mock.calls[0][1]?.headers).not.toHaveProperty('Cookie');
  });

  it.each([
    { token: '', headerName: 'X-XSRF-TOKEN' },
    { token: 'csrf', headerName: 'Authorization' },
    { token: 'csrf\r\ninjected', headerName: 'X-XSRF-TOKEN' },
  ])('rejects malformed token responses (%j)', async (payload) => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify(payload)));
    const { apiRequestHeaders } = await import('./csrf');
    await expect(apiRequestHeaders(BASE, '/tasks', 'POST')).rejects.toThrow();
  });
});
