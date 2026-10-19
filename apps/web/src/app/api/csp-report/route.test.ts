import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { POST } from './route';

const warning = vi.spyOn(console, 'warn');

beforeEach(() => warning.mockReset().mockImplementation(() => undefined));
afterEach(() => warning.mockClear());

const send = (body: unknown) =>
  POST(new Request('https://nora.test/api/csp-report', {
    method: 'POST',
    body: JSON.stringify(body),
  }));

const loggedReport = () => {
  expect(warning).toHaveBeenCalledTimes(1);
  const [label, report] = warning.mock.calls[0];
  expect(label).toBe('[csp]');
  expect(report).not.toMatch(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u);
  return JSON.parse(report as string);
};

describe('CSP report logging', () => {
  it('keeps legacy report fields separate from forged log fields and terminal controls', async () => {
    const blocked = 'https://blocked.test/" document=forged\n\u001b[2J\u0085next';
    const response = await send({ 'csp-report': {
      'violated-directive': 'script-src',
      'blocked-uri': blocked,
      'document-uri': 'https://nora.test/dashboard',
    } });

    expect(response.status).toBe(204);
    expect(loggedReport()).toEqual({
      directive: 'script-src',
      blocked: blocked.replace(/\s+/g, ' '),
      document: 'https://nora.test/dashboard',
    });
  });

  it('logs the Reporting API format with escaped controls and bounded fields', async () => {
    const response = await send([{ type: 'csp-violation', body: {
      effectiveDirective: 'style-src',
      blockedURL: 'x'.repeat(301),
      documentURL: 'https://nora.test/\u009b31m\u2028page',
    } }]);

    expect(response.status).toBe(204);
    expect(loggedReport()).toEqual({
      directive: 'style-src',
      blocked: `${'x'.repeat(300)}…`,
      document: 'https://nora.test/\u009b31m page',
    });
  });

  it.each([null, {}, [{ type: 'other' }]])('ignores unrecognized report shapes (%j)', async (body) => {
    expect((await send(body)).status).toBe(204);
    expect(warning).not.toHaveBeenCalled();
  });

  it.each(['not JSON', ' '.repeat(32 * 1024 + 1)])('drops malformed or oversized bodies', async (body) => {
    const response = await POST(new Request('https://nora.test/api/csp-report', { method: 'POST', body }));
    expect(response.status).toBe(204);
    expect(warning).not.toHaveBeenCalled();
  });
});
