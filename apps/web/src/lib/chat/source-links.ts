import type { MeetingSource } from '@/lib/chat/workspace-context';

export interface ChatContentTransform {
  push(text: string): string;
  flush(): string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const URL_STARTS = ['http://', 'https://', 'www.'];

function escapedLabel(text: string): string {
  return text.replace(/[\\[\]]/g, '\\$&').replace(/\s+/g, ' ');
}

/** Rewrite only citations to meetings actually supplied to this answer's model context. */
export function createMeetingSourceLinkTransform(
  sources: readonly MeetingSource[],
): ChatContentTransform {
  const allowed = new Map(
    sources
      .filter((source) => UUID.test(source.id))
      .map((source) => [source.id.toLowerCase(), source]),
  );
  const references = new Map(
    sources
      .filter((source) => UUID.test(source.id) && /^M\d+$/.test(source.reference))
      .map((source) => [source.reference, source]),
  );
  let pending = '';

  const sourceLink = (source: MeetingSource): string =>
    `[${escapedLabel(source.title)}](/meetings/${source.id.toLowerCase()})`;

  const meeting = (destination: string): MeetingSource | null | undefined => {
    try {
      const url = new URL(
        /^www\./i.test(destination) ? `https://${destination}` : destination,
        'https://nora.invalid/',
      );
      const path = decodeURIComponent(url.pathname);
      const shorthandId = path.slice(1).replace(/\/$/, '');
      if (url.hostname === 'meetings' && UUID.test(shorthandId)) {
        return allowed.get(shorthandId.toLowerCase()) ?? null;
      }
      if (!path.startsWith('/meetings/')) return undefined;
      const id = path.slice('/meetings/'.length).replace(/\/$/, '').toLowerCase();
      return allowed.get(id) ?? null;
    } catch {
      // An invalid meeting destination must not fall back to an active generated citation.
      return /(?:\/|%2f)meetings(?:\/|%2f)/i.test(destination) ? null : undefined;
    }
  };

  const standalone = (url: string, original: string): string => {
    const source = meeting(url);
    if (source === undefined) return original;
    return source ? sourceLink(source) : `\`${url.replace(/`/g, '')}\``;
  };

  const drain = (final: boolean): string => {
    let out = '';
    while (pending) {
      const marker = /\[|<|https?:\/\/|www\./i.exec(pending);
      if (!marker) {
        let keep = 0;
        if (!final) {
          for (const start of URL_STARTS) {
            for (let size = 1; size < start.length; size += 1) {
              if (pending.toLowerCase().endsWith(start.slice(0, size))) keep = Math.max(keep, size);
            }
          }
        }
        out += pending.slice(0, pending.length - keep);
        pending = keep ? pending.slice(-keep) : '';
        break;
      }
      out += pending.slice(0, marker.index);
      pending = pending.slice(marker.index);

      if (pending[0] === '[') {
        // A citation's label and URL can each span many provider deltas. Hold only that token.
        let depth = 1;
        let close = 1;
        for (; close < pending.length && depth; close += 1) {
          if (pending[close] === '\\') close += 1;
          else if (pending[close] === '[') depth += 1;
          else if (pending[close] === ']') depth -= 1;
        }
        if (depth || close === pending.length) {
          if (!final) break;
          const source = depth ? undefined : references.get(pending.slice(1, close - 1));
          out += source ? sourceLink(source) : pending;
          pending = '';
          break;
        }
        if (pending[close] !== '(') {
          if (pending[close] === '[') {
            const end = pending.indexOf(']', close + 1);
            if (end < 0 && !final) break;
            if (end >= 0) {
              out += pending.slice(0, end + 1);
              pending = pending.slice(end + 1);
              continue;
            }
          }
          if (pending[close] === ':') {
            const newline = pending.indexOf('\n', close);
            if (newline < 0 && !final) break;
            const length = newline < 0 ? pending.length : newline;
            const definition = pending.slice(0, length);
            const destination = /^:\s*(?:<([^>]*)>|([^\s]+))/.exec(definition.slice(close));
            const source = meeting(destination?.[1] ?? destination?.[2] ?? '');
            if (source === undefined) out += definition;
            else if (source) {
              out += `${definition.slice(0, close)}: /meetings/${source.id.toLowerCase()}`;
              out += definition.slice(close + (destination?.[0].length ?? 0));
            } else out += definition.slice(0, close);
            pending = pending.slice(length);
            continue;
          }
          const source = references.get(pending.slice(1, close - 1));
          out += source ? sourceLink(source) : pending.slice(0, close);
          pending = pending.slice(close);
          continue;
        }
        depth = 1;
        let end = close + 1;
        for (; end < pending.length && depth; end += 1) {
          if (pending[end] === '\\') end += 1;
          else if (pending[end] === '(') depth += 1;
          else if (pending[end] === ')') depth -= 1;
        }
        if (depth && !final) break;
        const label = pending.slice(1, close - 1);
        const destination = pending.slice(close + 1, depth ? pending.length : end - 1);
        const url = /^\s*(?:<([^>]*)>|([^\s]+))/.exec(destination);
        const source = meeting(url?.[1] ?? url?.[2] ?? '');
        if (source === undefined) out += pending.slice(0, end);
        else if (source) out += `[${label}](/meetings/${source.id.toLowerCase()})`;
        else {
          const labelLinks = createMeetingSourceLinkTransform(sources);
          out += labelLinks.push(label) + labelLinks.flush();
        }
        pending = pending.slice(end);
        continue;
      }

      if (pending[0] === '<') {
        const end = pending.indexOf('>');
        if (end < 0 && !final) break;
        const length = end < 0 ? pending.length : end + 1;
        const token = pending.slice(0, length);
        out += standalone(token.slice(1, end < 0 ? undefined : -1), token);
        pending = pending.slice(length);
        continue;
      }

      const end = pending.search(/[\s<>]/);
      if (end < 0 && !final) break;
      const length = end < 0 ? pending.length : end;
      const token = pending.slice(0, length);
      const url = token.replace(/[.,;!?)]+$/, '');
      out += standalone(url, url) + token.slice(url.length);
      pending = pending.slice(length);
    }
    return out;
  };

  return {
    push(text) {
      pending += text;
      return drain(false);
    },
    flush() {
      return drain(true);
    },
  };
}
