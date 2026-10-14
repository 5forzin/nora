/**
 * The provider-facing half of the chat stream: SSE in, NDJSON out.
 *
 * Everything asserted here was previously defended by nothing but the comments in the route
 * handler, and each of the last four commits on the chat touched it. In particular the idle budget
 * is new, and it is the kind of behaviour that only ever shows up in production: a provider that
 * flushes its headers, sends one token and then stops used to hold the request until the edge gave
 * up two minutes later, which looks exactly like the header stall that was already fixed.
 *
 * The upstream here is a real `ReadableStream`, not a mock, because the property under test is how
 * the loop behaves against a stream that chunks awkwardly or goes quiet — a stubbed reader would
 * only prove that the stub was called.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { openAiSseToNdjson, type StreamTrace, type StreamUsage } from '@/lib/chat/sse-to-ndjson';
import { createMeetingSourceLinkTransform } from '@/lib/chat/source-links';

const IDLE_MS = 45_000;
const NOTICE = '\n\n_(interrupted)_';

it('appends trusted records after the completed answer and preserves their source links', async () => {
  const id = '12345678-9012-4012-8012-123456789012';
  const answer = 'The pilot remains conditional.';
  const appendix = `\n\n## Current tasks\n- Deliver plan [Source](/meetings/${id})`;
  const raw = await drain(
    openAiSseToNdjson(
      upstreamOf([
        `data: ${JSON.stringify({ choices: [{ delta: { content: answer } }] })}\n\n`,
        'data: [DONE]\n\n',
      ]),
      {
        onComplete: vi.fn(),
        trace: freshTrace(),
        idleTimeoutMs: IDLE_MS,
        idleNotice: NOTICE,
        completionContent: appendix,
        contentTransform: createMeetingSourceLinkTransform([{ reference: 'M1', id, title: 'Review' }]),
      },
    ),
  );
  const content = raw.trim().split('\n').map((line) => JSON.parse(line).c).join('');
  expect(content).toBe(answer + appendix);
});

it('does not append a complete task list to an interrupted response', async () => {
  vi.useFakeTimers();
  const upstream = stalledUpstreamOf(['data: {"choices":[{"delta":{"content":"Partial"}}]}\n\n']);
  const result = drain(openAiSseToNdjson(upstream.stream, {
    onComplete: vi.fn(), trace: freshTrace(), idleTimeoutMs: IDLE_MS, idleNotice: NOTICE,
    completionContent: '\n\n## Current tasks\n- Deliver plan',
  }));
  await vi.advanceTimersByTimeAsync(IDLE_MS + 1);
  const raw = await result;
  expect(raw).toContain('(interrupted)');
  expect(raw).not.toContain('Current tasks');
});

function freshTrace(): StreamTrace {
  return {
    startedAt: Date.now(),
    firstByteMs: null,
    sseLines: 0,
    reasoningChunks: 0,
    contentChunks: 0,
  };
}

/** A stream that emits the given chunks and closes — the shape a healthy provider produces. */
function upstreamOf(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}

/** A stream that emits what it is given and then never speaks again. */
function stalledUpstreamOf(chunks: string[]): {
  stream: ReadableStream<Uint8Array>;
  cancelled: () => boolean;
} {
  const encoder = new TextEncoder();
  let wasCancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      // Deliberately never closed.
    },
    cancel() {
      wasCancelled = true;
    },
  });
  return { stream, cancelled: () => wasCancelled };
}

async function drain(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let out = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    out += decoder.decode(value, { stream: true });
  }
  return out;
}

function delta(fields: { content?: string; reasoning_content?: string }): string {
  return `data: ${JSON.stringify({ choices: [{ delta: fields }] })}\n\n`;
}

beforeEach(() => {
  // `finish()` writes one diagnostic line per stream. It is load-bearing in production and pure
  // noise here, so it is silenced rather than removed.
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('openAiSseToNdjson', () => {
  it('normalizes citations split across answer deltas without changing reasoning', async () => {
    const id = '38209128-385f-40f4-a387-c250e9f8432f';
    const sourceLinks = createMeetingSourceLinkTransform([
      { reference: 'M1', id, title: 'Planning' },
    ]);
    const stream = openAiSseToNdjson(
      upstreamOf([
        delta({ reasoning_content: '[thinking](https://example.com/meetings/unknown)' }),
        delta({ content: 'Decision: [source](https://example.com/meetings/' }),
        delta({ content: `${id}) Follow-up [pending` }),
        'data: [DONE]\n\n',
      ]),
      {
        onComplete: () => undefined,
        trace: freshTrace(),
        idleTimeoutMs: IDLE_MS,
        idleNotice: NOTICE,
        contentTransform: sourceLinks,
      },
    );

    const frames = (await drain(stream))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(
      frames
        .filter((f) => f.t === 'r')
        .map((f) => f.c)
        .join(''),
    ).toBe('[thinking](https://example.com/meetings/unknown)');
    expect(
      frames
        .filter((f) => f.t === 'c')
        .map((f) => f.c)
        .join(''),
    ).toBe(`Decision: [source](/meetings/${id}) Follow-up [pending`);
  });

  it('flushes transformed answer text before the idle notice', async () => {
    vi.useFakeTimers();
    const upstream = stalledUpstreamOf([delta({ content: 'Text [unfinished' })]);
    const stream = openAiSseToNdjson(upstream.stream, {
      onComplete: () => undefined,
      trace: freshTrace(),
      idleTimeoutMs: IDLE_MS,
      idleNotice: NOTICE,
      contentTransform: createMeetingSourceLinkTransform([]),
    });
    const collected = drain(stream);
    await vi.advanceTimersByTimeAsync(IDLE_MS + 1);
    const content = (await collected)
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line).c)
      .join('');
    expect(content).toBe(`Text [unfinished${NOTICE}`);
  });

  it('frames reasoning and content apart, in arrival order', async () => {
    const trace = freshTrace();
    const stream = openAiSseToNdjson(
      upstreamOf([
        delta({ reasoning_content: 'let me think' }),
        delta({ content: 'The' }),
        delta({ content: ' answer' }),
        'data: [DONE]\n\n',
      ]),
      { onComplete: () => undefined, trace, idleTimeoutMs: IDLE_MS, idleNotice: NOTICE },
    );

    expect(await drain(stream)).toBe(
      '{"t":"r","c":"let me think"}\n{"t":"c","c":"The"}\n{"t":"c","c":" answer"}\n',
    );
    expect(trace.reasoningChunks).toBe(1);
    expect(trace.contentChunks).toBe(2);
  });

  it('reassembles an SSE event split across two chunks', async () => {
    const event = delta({ content: 'whole' });
    const cut = event.indexOf('cont');
    const stream = openAiSseToNdjson(upstreamOf([event.slice(0, cut), event.slice(cut)]), {
      onComplete: () => undefined,
      trace: freshTrace(),
      idleTimeoutMs: IDLE_MS,
      idleNotice: NOTICE,
    });

    expect(await drain(stream)).toBe('{"t":"c","c":"whole"}\n');
  });

  it('ignores lines that are not SSE data and payloads that do not parse', async () => {
    const trace = freshTrace();
    const stream = openAiSseToNdjson(
      upstreamOf([
        ': keep-alive\n\n',
        'event: ping\n\n',
        'data: {oops\n\n',
        delta({ content: 'ok' }),
      ]),
      { onComplete: () => undefined, trace, idleTimeoutMs: IDLE_MS, idleNotice: NOTICE },
    );

    expect(await drain(stream)).toBe('{"t":"c","c":"ok"}\n');
    // The unparseable payload still counted as a data line; only the two non-data ones did not.
    expect(trace.sseLines).toBe(2);
  });

  it('reports the usage block exactly once, on close', async () => {
    const seen: StreamUsage[] = [];
    const stream = openAiSseToNdjson(
      upstreamOf([
        delta({ content: 'hi' }),
        `data: ${JSON.stringify({ usage: { prompt_tokens: 120, completion_tokens: 34 } })}\n\n`,
        'data: [DONE]\n\n',
      ]),
      {
        onComplete: (usage) => seen.push(usage),
        trace: freshTrace(),
        idleTimeoutMs: IDLE_MS,
        idleNotice: NOTICE,
      },
    );

    await drain(stream);
    expect(seen).toEqual([{ promptTokens: 120, completionTokens: 34 }]);
  });

  it('reports usage once even when the provider closes without sending [DONE]', async () => {
    const seen: StreamUsage[] = [];
    const stream = openAiSseToNdjson(upstreamOf([delta({ content: 'hi' })]), {
      onComplete: (usage) => seen.push(usage),
      trace: freshTrace(),
      idleTimeoutMs: IDLE_MS,
      idleNotice: NOTICE,
    });

    await drain(stream);
    expect(seen).toHaveLength(1);
  });

  describe('idle budget', () => {
    it('ends a stream that goes silent mid-body, and says so in the answer', async () => {
      vi.useFakeTimers();
      const trace = freshTrace();
      const upstream = stalledUpstreamOf([delta({ content: 'half a sen' })]);

      const stream = openAiSseToNdjson(upstream.stream, {
        onComplete: () => undefined,
        trace,
        idleTimeoutMs: IDLE_MS,
        idleNotice: NOTICE,
      });

      const collected = drain(stream);
      // One millisecond short of the budget the stream is still waiting: a slow provider is not
      // a failed one, and firing early would truncate healthy answers.
      await vi.advanceTimersByTimeAsync(IDLE_MS - 1);
      expect(trace.idleTimedOut).toBeUndefined();

      await vi.advanceTimersByTimeAsync(2);
      expect(await collected).toBe(
        `{"t":"c","c":"half a sen"}\n${JSON.stringify({ t: 'c', c: NOTICE })}\n`,
      );
      expect(trace.idleTimedOut).toBe(true);
      // The upstream socket is released rather than left open for the edge to time out on.
      expect(upstream.cancelled()).toBe(true);
    });

    it('does not fire while chunks keep arriving, however long the answer runs', async () => {
      vi.useFakeTimers();
      const encoder = new TextEncoder();
      let controller!: ReadableStreamDefaultController<Uint8Array>;
      const upstream = new ReadableStream<Uint8Array>({
        start(c) {
          controller = c;
        },
      });
      const trace = freshTrace();
      const stream = openAiSseToNdjson(upstream, {
        onComplete: () => undefined,
        trace,
        idleTimeoutMs: IDLE_MS,
        idleNotice: NOTICE,
      });
      const collected = drain(stream);

      // Four gaps, each just under the budget, totalling far more than it.
      for (let i = 0; i < 4; i += 1) {
        controller.enqueue(encoder.encode(delta({ content: `${i}` })));
        await vi.advanceTimersByTimeAsync(IDLE_MS - 1_000);
      }
      controller.close();

      expect(await collected).toBe(
        '{"t":"c","c":"0"}\n{"t":"c","c":"1"}\n{"t":"c","c":"2"}\n{"t":"c","c":"3"}\n',
      );
      expect(trace.idleTimedOut).toBeUndefined();
    });
  });
});
