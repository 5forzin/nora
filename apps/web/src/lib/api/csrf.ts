const CSRF_COOKIE = 'XSRF-TOKEN';
const CSRF_HEADER = 'X-XSRF-TOKEN';
const BOOTSTRAP_TIMEOUT_MS = 6_000;

interface CsrfToken {
  token: string;
  headerName: string;
}

const browserBootstraps = new Map<string, Promise<CsrfToken>>();

function cookieValue(cookies: string, name: string): string | undefined {
  return cookies.split(';').map((cookie) => cookie.trim()).find((cookie) =>
    cookie.startsWith(`${name}=`),
  )?.slice(name.length + 1);
}

function requiresCsrf(path: string, method: string): boolean {
  return !['GET', 'HEAD', 'OPTIONS', 'TRACE'].includes(method)
    || (['GET', 'HEAD'].includes(method) && path.split('?')[0] === '/meetings/search');
}

async function bootstrap(apiBaseUrl: string, cookies: string, timeoutMs: number): Promise<{
  csrf: CsrfToken;
  cookie?: string;
}> {
  const response = await fetch(`${apiBaseUrl}/auth/csrf`, {
    headers: cookies ? { Cookie: cookies, Accept: 'application/json' } : { Accept: 'application/json' },
    credentials: 'include',
    cache: 'no-store',
    redirect: 'error',
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new Error('Não foi possível validar a sessão. Tente novamente.');
  const csrf = await response.json() as Partial<CsrfToken>;
  if (csrf.headerName !== CSRF_HEADER || typeof csrf.token !== 'string'
    || !csrf.token || /[\r\n;]/.test(csrf.token)) {
    throw new Error('Não foi possível validar a sessão. Tente novamente.');
  }
  const setCookies = response.headers.getSetCookie?.() ?? [response.headers.get('set-cookie') ?? ''];
  const cookie = setCookies.map((value) => value.split(';')[0])
    .find((value) => value.startsWith(`${CSRF_COOKIE}=`));
  return { csrf: csrf as CsrfToken, cookie };
}

/** Keep session cookies server-side and bind cookie-authenticated writes to their CSRF token. */
export async function apiRequestHeaders(
  apiBaseUrl: string,
  path: string,
  method = 'GET',
  initialHeaders?: HeadersInit,
  timeoutMs = BOOTSTRAP_TIMEOUT_MS,
): Promise<Record<string, string>> {
  const headers = new Headers(initialHeaders);
  const browser = typeof window !== 'undefined';
  if (browser) {
    headers.delete('Cookie');
  } else if (!headers.has('Cookie')) {
    try {
      const { cookies } = await import('next/headers');
      const all = (await cookies()).getAll();
      if (all.length) headers.set('Cookie', all.map((cookie) => `${cookie.name}=${cookie.value}`).join('; '));
    } catch {
      // Builds and scripts have no incoming request cookies.
    }
  }

  if (requiresCsrf(path, method.toUpperCase())) {
    const cookies = headers.get('Cookie') ?? '';
    if (browser) {
      let pending = browserBootstraps.get(apiBaseUrl);
      if (!pending) {
        pending = bootstrap(apiBaseUrl, '', timeoutMs).then(({ csrf }) => csrf)
          .finally(() => { browserBootstraps.delete(apiBaseUrl); });
        browserBootstraps.set(apiBaseUrl, pending);
      }
      headers.set(CSRF_HEADER, (await pending).token);
    } else if (cookieValue(cookies, 'nora_access') !== undefined
      || cookieValue(cookies, 'nora_refresh') !== undefined) {
      const existing = cookieValue(cookies, CSRF_COOKIE);
      if (existing) {
        headers.set(CSRF_HEADER, existing);
      } else {
        const { csrf, cookie } = await bootstrap(apiBaseUrl, cookies, timeoutMs);
        if (cookie !== `${CSRF_COOKIE}=${csrf.token}`) {
          throw new Error('Não foi possível validar a sessão. Tente novamente.');
        }
        headers.set('Cookie', `${cookies}; ${cookie}`);
        headers.set(CSRF_HEADER, csrf.token);
      }
    }
  }
  // Preserve the casing consumed by the API client and the chat context callers.
  return Object.fromEntries([...headers].map(([name, value]) => [
    name === 'cookie' ? 'Cookie' : name === 'x-xsrf-token' ? CSRF_HEADER
      : name === 'content-type' ? 'Content-Type' : name === 'accept' ? 'Accept'
      : name === 'x-nora-client' ? 'X-NORA-Client' : name === 'idempotency-key' ? 'Idempotency-Key' : name,
    value,
  ]));
}
