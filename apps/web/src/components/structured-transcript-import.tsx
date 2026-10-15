'use client';

import Link from 'next/link';
import type { Route } from 'next';
import { useEffect, useRef, useState } from 'react';
import { ApiRequestError, getMeeting, reprocessMeeting, uploadMeeting } from '@/lib/api/client';
import { MAX_IMPORT_BYTES, parseTranscriptImport, type ImportedTranscript, type ImportIssue } from '@/lib/transcript-import';

const PAGE_SIZE = 50;
const CONCURRENCY = 2;
const POLL_INTERVAL_MS = 2_000;
const REQUEST_TIMEOUT_MS = 30_000;
const ANALYSIS_TIMEOUT_MS = 5 * 60_000;

type ImportResult = {
  record: ImportedTranscript;
  status: 'queued' | 'uploading' | 'analyzing' | 'done' | 'failed' | 'unconfirmed';
  meetingId?: string;
  error?: string;
  failureKind?: 'upload' | 'analysis';
};

function bounded<T>(operation: Promise<T>, signal: AbortSignal, timeout = REQUEST_TIMEOUT_MS): Promise<T> {
  return new Promise((resolve, reject) => {
    const cancel = () => { clearTimeout(timer); reject(new Error('Import monitoring stopped')); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', cancel); reject(new Error('Import request timed out')); }, timeout);
    signal.addEventListener('abort', cancel, { once: true });
    if (signal.aborted) cancel();
    operation.then(resolve, reject).finally(() => { clearTimeout(timer); signal.removeEventListener('abort', cancel); });
  });
}

function pollDelay(signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const finish = () => { clearTimeout(timer); signal.removeEventListener('abort', finish); resolve(); };
    const timer = setTimeout(finish, POLL_INTERVAL_MS);
    signal.addEventListener('abort', finish, { once: true });
    if (signal.aborted) finish();
  });
}

function unfinished(items: ImportResult[] | null): boolean {
  return items?.some((item) => ['queued', 'uploading', 'analyzing', 'unconfirmed'].includes(item.status)) ?? false;
}

function importDate(value?: string): string {
  if (!value) return 'Data não informada';
  return new Intl.DateTimeFormat('pt-BR', {
    dateStyle: 'short', timeStyle: 'short', timeZone: 'America/Sao_Paulo',
  }).format(new Date(value));
}

export function StructuredTranscriptImport({ onBusyChange, canReprocess = false }: { onBusyChange: (busy: boolean) => void; canReprocess?: boolean }) {
  const [filename, setFilename] = useState('');
  const [records, setRecords] = useState<ImportedTranscript[]>([]);
  const [issues, setIssues] = useState<ImportIssue[]>([]);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [duplicates, setDuplicates] = useState(0);
  const [totalRows, setTotalRows] = useState(0);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [language, setLanguage] = useState('pt-BR');
  const [page, setPage] = useState(0);
  const [busy, setBusy] = useState(false);
  const [paused, setPaused] = useState(false);
  const [parsing, setParsing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [results, setResults] = useState<ImportResult[] | null>(null);
  const busyRef = useRef(false);
  const pausedRef = useRef(false);
  const mountedRef = useRef(true);
  const lifecycle = useRef(new AbortController());
  const resultsRef = useRef<ImportResult[] | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    mountedRef.current = true;
    lifecycle.current = new AbortController();
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (!unfinished(resultsRef.current)) return;
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', beforeUnload);
    return () => {
      mountedRef.current = false;
      pausedRef.current = true;
      lifecycle.current.abort();
      window.removeEventListener('beforeunload', beforeUnload);
    };
  }, []);

  useEffect(() => { onBusyChange(busy || unfinished(results)); }, [busy, results, onBusyChange]);

  function markBusy(value: boolean) {
    busyRef.current = value;
    setBusy(value);
  }

  function replaceResults(value: ImportResult[] | null) {
    resultsRef.current = value;
    setResults(value);
  }

  function pause() {
    pausedRef.current = true;
    setPaused(true);
  }

  async function readFile(file?: File) {
    if (!file || busyRef.current) return;
    setError(null);
    setFilename('');
    setRecords([]);
    setIssues([]);
    setWarnings([]);
    setSelected(new Set());
    replaceResults(null);
    setPage(0);
    if (file.size > MAX_IMPORT_BYTES) {
      setError('O arquivo passa do limite de 64 MB.');
      return;
    }
    markBusy(true);
    setParsing(true);
    try {
      const parsed = await parseTranscriptImport(file);
      if (!mountedRef.current) return;
      setFilename(file.name);
      setRecords(parsed.records);
      setIssues(parsed.issues);
      setWarnings(parsed.warnings);
      setDuplicates(parsed.duplicates);
      setTotalRows(parsed.totalRows);
      // Selection is explicit: reading a file never queues every meeting for paid analysis.
      setSelected(new Set());
    } catch (failure) {
      if (mountedRef.current) setError(failure instanceof Error ? failure.message : 'Não foi possível ler o arquivo.');
    } finally {
      if (mountedRef.current) { setParsing(false); markBusy(false); }
    }
  }

  function patchResult(key: string, update: Partial<ImportResult>) {
    if (!mountedRef.current) return;
    replaceResults(resultsRef.current?.map((item) => item.record.idempotencyKey === key ? { ...item, ...update } : item) ?? null);
  }

  async function monitor(item: ImportResult, meetingId: string, retryAnalysis: boolean, signal: AbortSignal) {
    const key = item.record.idempotencyKey;
    const deadline = Date.now() + ANALYSIS_TIMEOUT_MS;
    let failures = 0;
    let mayReprocess = retryAnalysis && canReprocess;
    patchResult(key, { status: 'analyzing', meetingId, error: undefined });
    while (mountedRef.current && !signal.aborted) {
      try {
        const meeting = await bounded(getMeeting(meetingId), signal);
        if (!mountedRef.current) return;
        failures = 0;
        if (meeting.processingStatus === 'COMPLETED') {
          patchResult(key, { status: 'done', error: undefined, failureKind: undefined });
          return;
        }
        if (meeting.processingStatus === 'FAILED') {
          if (!mayReprocess) {
            patchResult(key, { status: 'failed', failureKind: 'analysis', error: 'A análise falhou.' });
            return;
          }
          mayReprocess = false;
          await bounded(reprocessMeeting(meetingId), signal);
        }
      } catch {
        if (!mountedRef.current) return;
        failures++;
      }
      if (failures >= 3 || Date.now() >= deadline) {
        patchResult(key, { status: 'unconfirmed', error: 'Status não confirmado. Consulte novamente antes de continuar.' });
        pause();
        return;
      }
      await pollDelay(signal);
    }
  }

  async function processItem(item: ImportResult, retryAnalysis: boolean, signal: AbortSignal) {
    const { record } = item;
    if (item.meetingId) {
      await monitor(item, item.meetingId, retryAnalysis, signal);
      return;
    }
    patchResult(record.idempotencyKey, { status: 'uploading', error: undefined });
    try {
      const response = await bounded(uploadMeeting({
        title: record.title, language, transcriptFormat: 'TXT',
        startedAt: record.startedAt, endedAt: record.endedAt,
        attributes: record.attributes, idempotencyKey: record.idempotencyKey,
        file: new File([record.text], 'transcript.txt', { type: 'text/plain;charset=utf-8' }),
      }), signal);
      if (!mountedRef.current) return;
      await monitor(item, response.id, false, signal);
    } catch (failure) {
      if (!mountedRef.current) return;
      const rejected = failure instanceof ApiRequestError && failure.status >= 400 && failure.status < 500;
      patchResult(record.idempotencyKey, {
        status: rejected ? 'failed' : 'unconfirmed', failureKind: 'upload',
        error: rejected ? failure.message : 'Envio não confirmado. Retome para verificar sem duplicar a reunião.',
      });
      pause();
    }
  }

  async function run(items: ImportResult[], retryFailures = false) {
    if (busyRef.current || !mountedRef.current || items.length === 0) return;
    pausedRef.current = false;
    setPaused(false);
    markBusy(true);
    const signal = lifecycle.current.signal;
    let cursor = 0;
    async function worker() {
      while (mountedRef.current && !pausedRef.current && cursor < items.length) {
        const item = items[cursor++];
        await processItem(item, retryFailures && item.status === 'failed' && item.failureKind === 'analysis', signal);
      }
    }
    try {
      await Promise.all(Array.from({ length: Math.min(CONCURRENCY, items.length) }, worker));
    } finally {
      if (mountedRef.current) {
        markBusy(false);
        if (unfinished(resultsRef.current)) pause();
      }
    }
  }

  function resume() {
    if (busyRef.current) {
      pausedRef.current = false;
      setPaused(false);
      return;
    }
    const current = resultsRef.current ?? [];
    void run([...current.filter((item) => item.status === 'unconfirmed'), ...current.filter((item) => item.status === 'queued')]);
  }

  function submit() {
    if (busyRef.current) return;
    const items: ImportResult[] = records.filter((record) => selected.has(record.idempotencyKey)).map((record) => ({ record, status: 'queued' }));
    if (!items.length) return;
    replaceResults(items);
    setPage(0);
    void run(items);
  }

  function toggle(key: string) {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  const shown: ImportResult[] = results ?? records.map((record) => ({ record, status: 'queued' as const }));
  const pages = Math.max(1, Math.ceil(shown.length / PAGE_SIZE));
  const done = results?.filter((item) => item.status === 'done').length ?? 0;
  const failed = results?.filter((item) => item.status === 'failed') ?? [];
  const unconfirmed = results?.filter((item) => item.status === 'unconfirmed') ?? [];
  const queued = results?.filter((item) => item.status === 'queued').length ?? 0;
  const active = results?.filter((item) => item.status === 'uploading' || item.status === 'analyzing').length ?? 0;
  const retryable = failed.filter((item) => item.failureKind === 'upload' || canReprocess);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      {!results && (
        <div className="field">
          <label className="field-label" htmlFor="structured-import-file">Arquivo de reuniões</label>
          <input ref={fileInput} id="structured-import-file" className="sr-only" type="file" accept=".json,.jsonl,.csv" disabled={busy} tabIndex={-1}
            onChange={(event) => { void readFile(event.target.files?.[0]); event.target.value = ''; }} />
          <button type="button" className="btn btn-ghost" style={{ alignSelf: 'flex-start' }} disabled={busy} onClick={() => fileInput.current?.click()}>
            {filename ? 'Trocar arquivo' : 'Escolher arquivo'}
          </button>
          <div className="field-help">JSON, JSONL ou CSV · até 64 MB. Escolha as reuniões antes de enviar.</div>
        </div>
      )}
      {parsing && <p role="status" style={{ color: 'var(--muted)', margin: 0 }}>Lendo arquivo…</p>}
      {error && <div className="notice notice--danger" role="alert">{error}</div>}
      {filename && (
        <div>
          <div style={{ fontSize: 14, fontWeight: 500, overflowWrap: 'anywhere' }}>{filename}</div>
          <p style={{ fontSize: 12.5, color: 'var(--muted)', margin: '6px 0 0' }}>
            {totalRows} registros · {records.length} válidos · {duplicates} repetidos · {issues.length} inválidos
          </p>
        </div>
      )}
      {issues.length > 0 && !results && (
        <details className="notice">
          <summary style={{ cursor: 'pointer' }}>Ver registros não importados ({issues.length})</summary>
          <ul style={{ margin: '12px 0 0', paddingLeft: 20, maxHeight: 180, overflow: 'auto', fontSize: 12.5 }}>
            {issues.map((issue, index) => <li key={index}>Registro {issue.row}: {issue.message}</li>)}
          </ul>
        </details>
      )}
      {warnings.length > 0 && !results && <div className="notice" role="status"><ul style={{ margin: 0, paddingLeft: 18, fontSize: 12.5 }}>{warnings.map((warning) => <li key={warning}>{warning}</li>)}</ul></div>}
      {filename && records.length === 0 && <p style={{ color: 'var(--muted)', margin: 0 }}>Nenhuma reunião válida neste arquivo.</p>}
      {records.length > 0 && !results && (
        <>
          <div className="field" style={{ maxWidth: 240 }}>
            <label className="field-label" htmlFor="import-language">Idioma das transcrições</label>
            <select id="import-language" className="select" value={language} onChange={(event) => setLanguage(event.target.value)} disabled={busy}>
              <option value="pt-BR">Português (BR)</option>
              <option value="en-US">Inglês (US)</option>
              <option value="es-ES">Espanhol</option>
            </select>
          </div>
          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between' }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13 }}>
              <input type="checkbox" checked={selected.size === records.length} ref={(input) => { if (input) input.indeterminate = selected.size > 0 && selected.size < records.length; }} onChange={(event) => setSelected(event.target.checked ? new Set(records.map((record) => record.idempotencyKey)) : new Set())} />
              Selecionar todas ({records.length})
            </label>
            <button type="button" className="btn btn-primary" disabled={!selected.size || busy} onClick={submit}>
              Importar {selected.size} {selected.size === 1 ? 'reunião' : 'reuniões'}
            </button>
          </div>
        </>
      )}
      {results && (
        <div className="card card--pad">
          <h2 style={{ margin: 0, fontSize: 18, fontWeight: 500 }} role="status">{done} de {results.length} {results.length === 1 ? 'análise concluída' : 'análises concluídas'}</h2>
          {(active > 0 || queued > 0) && <p style={{ margin: '8px 0 0', color: 'var(--muted)', fontSize: 13 }}>{active} em processamento · {queued} na fila</p>}
          {paused && <p style={{ margin: '8px 0 0', fontSize: 13 }}>Fila pausada.{active > 0 ? ' As análises já enviadas continuam.' : ''}</p>}
          {unfinished(results) && <p style={{ margin: '8px 0 0', color: 'var(--muted)', fontSize: 13 }}>Mantenha esta aba aberta. Ao sair, as reuniões na fila não serão enviadas.</p>}
          {failed.length > 0 && <p style={{ margin: '8px 0 0', color: 'var(--danger)', fontSize: 13 }}>{failed.length} {failed.length === 1 ? 'falha' : 'falhas'}.</p>}
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginTop: 16 }}>
            {busy && queued > 0 && !paused && <button type="button" className="btn btn-ghost" onClick={pause}>Pausar fila</button>}
            {(paused || !busy) && (queued > 0 || unconfirmed.length > 0) && <button type="button" className="btn btn-primary" disabled={busy && unconfirmed.length > 0} onClick={resume}>{unconfirmed.length > 0 ? 'Consultar e retomar' : 'Retomar fila'}</button>}
            {retryable.length > 0 && <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => void run([...unconfirmed, ...retryable], true)}>Tentar falhas novamente</button>}
            <Link href="/dashboard" className="btn btn-ghost">Ver reuniões</Link>
            <button type="button" className="btn btn-ghost" disabled={busy || unfinished(results)} onClick={() => { replaceResults(null); setRecords([]); setSelected(new Set()); setFilename(''); setIssues([]); setWarnings([]); setPage(0); setPaused(false); }}>Importar outro arquivo</button>
          </div>
        </div>
      )}
      <ul className="m-0 list-none space-y-3 p-0">
        {shown.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE).map((item) => (
          <li key={item.record.idempotencyKey} className="card card--pad min-w-0">
            <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
              {!results && <input style={{ marginTop: 4 }} type="checkbox" aria-label={`Selecionar ${item.record.title}`} checked={selected.has(item.record.idempotencyKey)} onChange={() => toggle(item.record.idempotencyKey)} />}
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 14, fontWeight: 500, overflowWrap: 'anywhere' }}>{item.record.title}</div>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px 14px', color: 'var(--muted)', fontSize: 12, marginTop: 6, overflowWrap: 'anywhere' }}>
                  <span>ID {item.record.sourceId}</span>
                  {item.record.clientCode && <span>Cliente {item.record.clientCode}</span>}
                  <span>{importDate(item.record.startedAt)}</span>
                </div>
                {!results && <details style={{ marginTop: 12, fontSize: 12.5 }}>
                  <summary style={{ cursor: 'pointer', color: 'var(--accent-ink)' }}>Ver transcrição</summary>
                  <pre style={{ font: 'inherit', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', maxHeight: 240, overflow: 'auto', margin: '10px 0 0', lineHeight: 1.6 }}>{item.record.text}</pre>
                </details>}
                {results && <div style={{ marginTop: 10, fontSize: 12.5 }}>
                  {item.status === 'done' && <span>Concluída</span>}
                  {item.status === 'uploading' && <span>Enviando…</span>}
                  {item.status === 'analyzing' && <span>Analisando…</span>}
                  {item.status === 'queued' && <span style={{ color: 'var(--muted)' }}>Na fila</span>}
                  {(item.status === 'failed' || item.status === 'unconfirmed') && <span style={{ color: 'var(--danger)' }}>{item.error}</span>}
                  {item.meetingId && <Link href={`/meetings/${item.meetingId}` as Route} style={{ color: 'var(--accent-ink)', marginLeft: 12 }}>Abrir reunião</Link>}
                </div>}
              </div>
            </div>
          </li>
        ))}
      </ul>
      {pages > 1 && <nav aria-label="Páginas da importação" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
        <button type="button" className="btn btn-ghost" disabled={page === 0} onClick={() => setPage((current) => current - 1)}>Anterior</button>
        <span style={{ fontSize: 12, color: 'var(--muted)' }}>{page + 1} de {pages}</span>
        <button type="button" className="btn btn-ghost" disabled={page + 1 === pages} onClick={() => setPage((current) => current + 1)}>Próxima</button>
      </nav>}
    </div>
  );
}
