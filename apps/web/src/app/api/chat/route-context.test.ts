import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('next/headers', () => ({
  cookies: async () => ({ getAll: () => [{ name: 'nora_access', value: 'test-session' }] }),
}));

const ID = '12345678-9012-4012-8012-123456789012';
const DENIED_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const fetchMock = vi.fn<typeof fetch>();
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

beforeEach(() => {
  vi.resetModules();
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
  vi.stubEnv('API_BASE_URL', 'https://api.test.invalid');
  vi.stubEnv('LLM_BASE_URL', 'https://llm.test.invalid/v1');
  vi.stubEnv('LLM_PROVIDER', 'openai');
  vi.stubEnv('LLM_API_KEY', 'test-key');
  vi.stubEnv('LLM_KEY_OPENAI', 'test-key');
  vi.stubEnv('NORA_PLATFORM_INTERNAL_TOKEN', '');
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('chat evidence sent to the provider', () => {
  it.each([
    { plan: 'FREE', capabilities: { readCompanyContext: true } },
    { plan: 'PRO', capabilities: { readCompanyContext: true } },
    { plan: 'ENTERPRISE', capabilities: { readCompanyContext: false } },
    {},
  ])('does not retrieve company context without current Enterprise access (%j)', async (access) => {
    fetchMock.mockImplementation(async (input) => {
      const url = new URL(String(input));
      if (url.pathname === '/auth/me') return json({ userId: 'reader', tenantId: 'tenant', ...access });
      if (url.pathname === '/tenant/context') return json({ companyName: 'PRIVATE_COMPANY_CONTEXT' });
      if (url.hostname === 'llm.test.invalid') return new Response('data: [DONE]\n\n');
      return json({ items: [], totalItems: 0 });
    });
    const { POST } = await import('./route');
    const response = await POST(new Request('https://nora.test.invalid/api/chat', {
      method: 'POST',
      body: JSON.stringify({ messages: [{ role: 'user', content: 'Summarize my meetings' }] }),
    }));
    expect(response.status).toBe(200);
    await response.text();
    expect(fetchMock.mock.calls.some(([input]) => String(input).endsWith('/tenant/context'))).toBe(false);
    const provider = fetchMock.mock.calls.find(([input]) => String(input).startsWith('https://llm.test.invalid'));
    expect(provider).toBeDefined();
    expect(String(provider?.[1]?.body)).not.toContain('PRIVATE_COMPANY_CONTEXT');
  });

  it('includes detailed evidence and valid source links while redacting query, history and context', async () => {
    fetchMock.mockImplementation(async (input) => {
      const url = new URL(String(input));
      if (url.pathname === '/auth/me') return json({ userId: 'reader', tenantId: 'tenant', plan: 'ENTERPRISE', capabilities: { readCompanyContext: true } });
      if (url.pathname === '/tenant/context')
        return json({ companyName: 'Company', valueProposition: 'Contact company@example.com' });
      if (url.pathname === '/meetings/search')
        return json({
          items: [
            { id: ID, title: 'Review', summarySnippet: 'Introduction only' },
            { id: DENIED_ID, title: 'Private acquisition', summarySnippet: 'Private evidence' },
          ],
        });
      if (url.pathname === `/meetings/${DENIED_ID}`) return json({ error: 'forbidden' }, 403);
      if (url.pathname === `/meetings/${ID}`)
        return json({
          id: ID,
          title: 'Review client@example.com',
          startedAt: '2026-10-14T13:00:00Z',
          processingStatus: 'COMPLETED',
          analysis: {
            summary: `${'Routine discussion. '.repeat(25)}A supplier delay threatens renewal.`,
            decisions: [{ text: 'Escalate to operations' }],
            risks: [
              {
                severity: 'HIGH',
                text: 'Renewal could be lost',
                sourceQuote: 'Contact owner@example.com',
              },
            ],
            opportunities: [{ text: 'Add a second region', sourceQuote: '' }],
            actionItems: [
              {
                title: 'Prepare proposal',
                assignee: 'sales@example.com',
                status: 'OPEN',
                sourceQuote: '',
              },
            ],
          },
        });
      if (url.pathname === '/tasks') {
        if (url.searchParams.get('status') === 'IN_PROGRESS')
          throw new Error('temporary task failure');
        return json({
          items: [
            { id: 'task-1', meetingId: ID, status: 'OPEN', title: 'Confirm recovery', priority: 'HIGH', meetingTitle: 'Review' },
          ],
          totalItems: 1,
        });
      }
      if (url.hostname === 'llm.test.invalid')
        return new Response(
          `data: ${JSON.stringify({ choices: [{ delta: { content: `[Review](https://example.com/meetings/${ID})` } }] })}\n\ndata: [DONE]\n\n`,
          { headers: { 'Content-Type': 'text/event-stream' } },
        );
      throw new Error(`Unexpected test URL: ${url}`);
    });

    const { POST } = await import('./route');
    const response = await POST(
      new Request('https://nora.test.invalid/api/chat', {
        method: 'POST',
        body: JSON.stringify({
          messages: [{ role: 'user', content: 'What are the risks for user@example.com?' }],
        }),
      }),
    );
    expect(response.status).toBe(200);
    const streamed = await response.text();
    expect(streamed).toContain(`(/meetings/${ID})`);
    expect(streamed).not.toContain('example.com');

    const search = fetchMock.mock.calls.find(([input]) =>
      String(input).includes('/meetings/search'),
    )!;
    expect(decodeURIComponent(String(search[0]))).not.toContain('user@example.com');
    const provider = fetchMock.mock.calls.find(([input]) =>
      String(input).startsWith('https://llm.test.invalid'),
    )!;
    const body = JSON.parse(String(provider[1]?.body)) as {
      messages: Array<{ role: string; content: string }>;
    };
    const system = body.messages[0].content;
    expect(system).toContain('A supplier delay threatens renewal.');
    expect(system).toContain('Escalate to operations');
    expect(system).toContain('Renewal could be lost');
    expect(system).toContain('Add a second region');
    expect(system).toContain('Prepare proposal');
    expect(system).toContain('Confirm recovery');
    expect(system).toContain(`(/meetings/${ID})`);
    expect(system).toContain('Partial list');
    expect(system).not.toContain('Introduction only');
    expect(system).not.toContain('Private acquisition');
    expect(system).not.toContain('Private evidence');
    expect(system).not.toContain(DENIED_ID);
    expect(JSON.stringify(body)).not.toContain('@example.com');
    expect(system).toContain('[[EMAIL_');
    for (const [input, options] of fetchMock.mock.calls) {
      if (String(input).startsWith('https://api.test.invalid')) {
        expect(options?.headers).toMatchObject({ Cookie: 'nora_access=test-session' });
      }
    }

    const overview = await POST(new Request('https://nora.test.invalid/api/chat', {
      method: 'POST',
      body: JSON.stringify({ messages: [{ role: 'user', content: 'Executive overview of decisions, risks and pending tasks' }] }),
    }));
    const appendixStream = await overview.text();
    expect(appendixStream).toContain('Pendências consultadas (1)');
    expect(appendixStream).toContain('Confirm recovery');
    expect(appendixStream).toContain(`(/meetings/${ID})`);
    expect(appendixStream).toContain('parcial');
    const overviewCall = fetchMock.mock.calls.filter(([input]) =>
      String(input).startsWith('https://llm.test.invalid'),
    ).at(-1)!;
    const overviewSystem = JSON.parse(String(overviewCall[1]?.body)).messages[0].content;
    expect(overviewSystem).toContain('Renewal could be lost');
    expect(overviewSystem).toContain('Escalate to operations');
    expect(overviewSystem).not.toContain('Prepare proposal');
    expect(overviewSystem).not.toContain('Confirm recovery');
  });

  it('does not retrieve evidence or contact the model without a validated session', async () => {
    fetchMock.mockResolvedValue(json({ error: 'unauthorized' }, 401));
    const { POST } = await import('./route');
    const response = await POST(
      new Request('https://nora.test.invalid/api/chat', {
        method: 'POST',
        body: JSON.stringify({ messages: [{ role: 'user', content: 'Company risks' }] }),
      }),
    );
    expect(response.status).toBe(401);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0][0])).toMatch(/\/auth\/me$/);
  });
});
