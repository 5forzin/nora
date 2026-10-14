import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

import { createMeetingSourceLinkTransform } from '@/lib/chat/source-links';

const ID = '38209128-385f-40f4-a387-c250e9f8432f';
const OTHER = '21b42ee3-0167-4871-bfd4-19c9ff4c3b4c';
const SOURCES = [{ reference: 'M1', id: ID, title: 'Planning [review]' }];

function transform(parts: string[], sources = SOURCES): string {
  const filter = createMeetingSourceLinkTransform(sources);
  return parts.map((part) => filter.push(part)).join('') + filter.flush();
}

describe('meeting source links', () => {
  it.each([
    `https://example.com/meetings/${ID}`,
    `http://invented.invalid/meetings/${ID}?download=1#summary`,
    `//invented.invalid/meetings/${ID}`,
    `/meetings/${ID}`,
    `meetings/${ID}`,
    `/meetings/${ID.toUpperCase()}/`,
    `https://example.com/%6deetings/${ID}`,
    `https://meetings/${ID}`,
    `http://meetings/${ID.toUpperCase()}/?summary=1#risks`,
  ])('canonicalizes a supplied source destination %s', (url) => {
    expect(transform([`See [meeting](${url}) for evidence.`])).toBe(
      `See [meeting](/meetings/${ID}) for evidence.`,
    );
  });

  it.each([
    `/meetings/${OTHER}`,
    `https://example.com/meetings/${OTHER}`,
    `https://meetings/${OTHER}`,
    '/meetings/invented-source',
    `/meetings/${ID}/different-record`,
    'https://example.com/meetings/%ZZ',
  ])('removes an unsupplied meeting destination %s', (url) => {
    expect(transform([`Decision [source](${url}) confirmed.`])).toBe('Decision source confirmed.');
  });

  it('does not authorize IDs that were not in this request context', () => {
    expect(transform([`[source](/meetings/${ID})`], [])).toBe('source');
  });

  it('links exact supplied standalone references using their request mapping', () => {
    const sources = [
      { reference: 'M6', id: ID, title: 'Planning [review]' },
      { reference: 'M3', id: OTHER, title: 'Finance review' },
      { reference: 'M5', id: '56518e09-8699-4935-a9cb-226e539f9179', title: 'Commercial review' },
    ];
    const input = 'Decisões [M6]; riscos [M3], [M5]; pendências [M99]. Fonte final [M6]';
    const expected =
      `Decisões [Planning \\[review\\]](/meetings/${ID}); ` +
      `riscos [Finance review](/meetings/${OTHER}), ` +
      '[Commercial review](/meetings/56518e09-8699-4935-a9cb-226e539f9179); ' +
      `pendências [M99]. Fonte final [Planning \\[review\\]](/meetings/${ID})`;
    for (let split = 0; split <= input.length; split += 1) {
      expect(transform([input.slice(0, split), input.slice(split)], sources)).toBe(expected);
    }
    const normalized = transform([...input], sources);
    expect(normalized).toBe(expected);
    const html = renderToStaticMarkup(
      createElement(ReactMarkdown, { remarkPlugins: [remarkGfm] }, normalized),
    );
    expect(html.match(/href=/g)).toHaveLength(4);
    expect(html).toContain(`href="/meetings/${ID}"`);
    expect(html).toContain(`href="/meetings/${OTHER}"`);
    expect(html).toContain('[M99]');
  });

  it('waits for a standalone reference to finish and flushes it exactly once', () => {
    const filter = createMeetingSourceLinkTransform([
      { reference: 'M6', id: ID, title: 'Planning' },
    ]);
    expect(filter.push('Source [M')).toBe('Source ');
    expect(filter.push('6]')).toBe('');
    expect(filter.flush()).toBe(`[Planning](/meetings/${ID})`);
    expect(filter.flush()).toBe('');
  });

  it.each(['[M99]', '[m6]', '[ M6 ]', '[M6, M3]', '[unrelated]', '[M6][docs]', '[M6][]'])(
    'does not reinterpret ordinary Markdown or unknown reference %s',
    (input) => {
      expect(transform([...input], [{ reference: 'M6', id: ID, title: 'Planning' }])).toBe(input);
    },
  );

  it('preserves inline reference labels and reference definitions', () => {
    const input =
      `[M6](https://example.com/meetings/${ID})\n` +
      `[M6]: https://example.com/meetings/${ID} "Planning"\n` +
      '[M3]: https://example.com/docs\n';
    expect(transform([...input], [{ reference: 'M6', id: ID, title: 'Planning' }])).toBe(
      `[M6](/meetings/${ID})\n[M6]: /meetings/${ID} "Planning"\n[M3]: https://example.com/docs\n`,
    );
  });

  it('does not authorize invalid source IDs or nonstandard reference keys', () => {
    const sources = [
      { reference: 'M6', id: 'invented-id', title: 'Planning' },
      { reference: 'm3', id: ID, title: 'Finance review' },
    ];
    expect(transform(['[M6], [m3]'], sources)).toBe('[M6], [m3]');
  });

  it('streams ordinary prose immediately and holds only an incomplete citation', () => {
    const filter = createMeetingSourceLinkTransform(SOURCES);
    expect(filter.push('Decision confirmed. ')).toBe('Decision confirmed. ');
    expect(filter.push('[Meeting]')).toBe('');
    expect(filter.push('(https://example.com/meetings/')).toBe('');
    expect(filter.push(`${ID}) Next action.`)).toBe(`[Meeting](/meetings/${ID}) Next action.`);
    expect(filter.flush()).toBe('');
  });

  it('handles every possible single split of an inline citation', () => {
    const input = `Evidence: [Planning](https://example.com/meetings/${ID}).`;
    for (let split = 0; split <= input.length; split += 1) {
      expect(transform([input.slice(0, split), input.slice(split)])).toBe(
        `Evidence: [Planning](/meetings/${ID}).`,
      );
    }
    expect(transform([...input])).toBe(`Evidence: [Planning](/meetings/${ID}).`);
  });

  it('normalizes the Portuguese executive answer with shorthand hosts at every chunk split', () => {
    const commercialId = '56518e09-8699-4935-a9cb-226e539f9179';
    const financeId = '53e064de-7800-4a58-94ed-a421315222a5';
    const sources = [
      { reference: 'M1', id: commercialId, title: 'Commercial review' },
      { reference: 'M2', id: financeId, title: 'Finance review' },
    ];
    const input =
      `Decisões: [Fonte](https://meetings/${commercialId}). ` +
      `Riscos: [Fonte](https://meetings/${financeId}). ` +
      `Pendências: [Fonte](https://meetings/${OTHER}).`;
    const expected =
      `Decisões: [Fonte](/meetings/${commercialId}). ` +
      `Riscos: [Fonte](/meetings/${financeId}). Pendências: Fonte.`;
    for (let split = 0; split <= input.length; split += 1) {
      expect(transform([input.slice(0, split), input.slice(split)], sources)).toBe(expected);
    }
    const normalized = transform([...input], sources);
    expect(normalized).toBe(expected);
    const html = renderToStaticMarkup(
      createElement(ReactMarkdown, { remarkPlugins: [remarkGfm] }, normalized),
    );
    expect(html).toContain(`href="/meetings/${commercialId}"`);
    expect(html).toContain(`href="/meetings/${financeId}"`);
    expect(html.match(/href=/g)).toHaveLength(2);
    expect(html).not.toContain('https://meetings');
    expect(html).not.toContain(OTHER);
  });

  it.each([
    `https://example.com/${ID}`,
    `https://meetings.example.com/${ID}`,
    `https://other-meetings/${ID}`,
    'https://meetings/documentation',
  ])('preserves ordinary destinations including source-like titles %s', (url) => {
    const input = `[Documentation](${url})`;
    expect(transform([...input])).toBe(input);
  });

  it('handles two citations with nested and escaped brackets in labels', () => {
    expect(
      transform([`[Planning [review]](/meetings/${ID}) and [Review \\]](/meetings/${OTHER}).`]),
    ).toBe(`[Planning [review]](/meetings/${ID}) and Review \\].`);
  });

  it.each([
    '[Docs](https://example.com/docs?query=(a))',
    '[Email](mailto:test@example.com)',
    '[Heading](#risks)',
    '[Docs](https://example.com/docs "Documentation")',
    '[not a link] in ordinary text',
    'Cost < expected cost.',
    '[unfinished label',
    '[unfinished](https://example.com/docs',
  ])('preserves ordinary Markdown %s', (input) => {
    expect(transform([...input])).toBe(input);
  });

  it('accepts angle-bracket destinations and drops provider-generated link titles', () => {
    expect(transform([`[source](<https://wrong.invalid/meetings/${ID}> "Untrusted title")`])).toBe(
      `[source](/meetings/${ID})`,
    );
  });

  it('normalizes autolinks and bare URLs without creating links for invented sources', () => {
    const input = `See <https://wrong.invalid/meetings/${ID}> and https://wrong.invalid/meetings/${OTHER}.`;
    expect(transform([...input])).toBe(
      `See [Planning \\[review\\]](/meetings/${ID}) and \`https://wrong.invalid/meetings/${OTHER}\`.`,
    );
  });

  it('keeps non-meeting bare links and autolinks unchanged', () => {
    const input = 'https://example.com/docs. <https://example.com/docs> www.example.com';
    expect(transform([...input])).toBe(input);
  });

  it('normalizes reference definitions while leaving ordinary references alone', () => {
    const input =
      `[known]: https://wrong.invalid/meetings/${ID} "Planning"\n` +
      `[unknown]: https://wrong.invalid/meetings/${OTHER}\n` +
      '[docs]: https://example.com/docs\n';
    expect(transform([...input])).toBe(
      `[known]: /meetings/${ID} "Planning"\n[unknown]\n[docs]: https://example.com/docs\n`,
    );
  });

  it('canonicalizes bare www meeting URLs', () => {
    expect(transform([`www.example.com/meetings/${ID}`])).toBe(
      `[Planning \\[review\\]](/meetings/${ID})`,
    );
  });

  it('flushes unfinished citation destinations safely and only once', () => {
    const filter = createMeetingSourceLinkTransform(SOURCES);
    expect(filter.push(`[source](https://wrong.invalid/meetings/${OTHER}`)).toBe('');
    expect(filter.flush()).toBe('source');
    expect(filter.flush()).toBe('');
  });

  it('does not let an unknown destination become a GFM link through its label', () => {
    const input = `[https://wrong.invalid/meetings/${OTHER}](/meetings/${OTHER})`;
    const html = renderToStaticMarkup(
      createElement(ReactMarkdown, { remarkPlugins: [remarkGfm] }, transform([...input])),
    );
    expect(html).not.toContain('href=');
    expect(html).toContain(OTHER);
  });

  it('renders supplied sources as active local links after streamed normalization', () => {
    const html = renderToStaticMarkup(
      createElement(
        ReactMarkdown,
        { remarkPlugins: [remarkGfm] },
        transform([...`See [source](https://example.com/meetings/${ID}).`]),
      ),
    );
    expect(html).toContain(`href="/meetings/${ID}"`);
    expect(html).not.toContain('example.com');
  });
});
