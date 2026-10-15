export interface ImportedTranscript {
  sourceId: string;
  clientCode?: string;
  title: string;
  text: string;
  startedAt?: string;
  endedAt?: string;
  attributes: Record<string, string>;
  idempotencyKey: string;
}

export interface ImportIssue {
  row: number;
  message: string;
}

export interface TranscriptImport {
  records: ImportedTranscript[];
  duplicates: number;
  issues: ImportIssue[];
  totalRows: number;
  warnings: string[];
}

export const MAX_IMPORT_BYTES = 64 * 1024 * 1024;
export const MAX_IMPORT_ROWS = 2_000;
const MAX_TRANSCRIPT_CHARACTERS = 1_000_000;
type SourceRow = Record<string, unknown>;

function normalizedText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

async function digest(value: string): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function field(row: SourceRow, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = row[key];
    if (typeof value === "string" && value.trim()) return value.trim();
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
    if (typeof value === "boolean") return String(value);
  }
  return undefined;
}

function isObject(value: unknown): value is SourceRow {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function readJson(text: string): unknown[] {
  try {
    const value: unknown = JSON.parse(text);
    if (Array.isArray(value)) return value;
    if (isObject(value)) {
      for (const key of ["records", "meetings", "data"]) {
        if (Array.isArray(value[key])) return value[key] as unknown[];
      }
      return [value];
    }
    throw new Error("O JSON deve conter uma reunião ou uma lista de reuniões.");
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    const lines = text.split(/\r?\n/).filter((line) => line.trim());
    if (lines.length < 2) throw new Error("JSON inválido. Confira o arquivo e tente novamente.");
    return lines.map((line, index) => {
      try {
        return JSON.parse(line) as unknown;
      } catch {
        throw new Error(`JSON inválido na linha ${index + 1}. Nenhuma reunião foi enviada.`);
      }
    });
  }
}

function readCsv(text: string, delimiter: string): string[][] {
  const rows: string[][] = [];
  let values: string[] = [];
  let value = "";
  let quoted = false;
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (char === '"') {
      if (quoted && text[index + 1] === '"') {
        value += '"';
        index++;
      } else if (quoted || value.length === 0) {
        quoted = !quoted;
      } else {
        value += char;
      }
    } else if (char === delimiter && !quoted) {
      values.push(value);
      value = "";
    } else if ((char === "\n" || char === "\r") && !quoted) {
      if (char === "\r" && text[index + 1] === "\n") index++;
      values.push(value);
      if (values.some((item) => item.trim())) rows.push(values);
      if (rows.length > MAX_IMPORT_ROWS + 1) {
        throw new Error(`O arquivo deve conter no máximo ${MAX_IMPORT_ROWS} registros.`);
      }
      values = [];
      value = "";
    } else {
      value += char;
    }
  }
  if (quoted) throw new Error("O CSV contém aspas sem fechamento.");
  values.push(value);
  if (values.some((item) => item.trim())) rows.push(values);
  return rows;
}

function csvRows(text: string, warnings: string[]): unknown[] {
  const firstLine = text.split(/[\r\n]/, 1)[0];
  const delimiter = [",", ";", "\t"].sort((a, b) => firstLine.split(b).length - firstLine.split(a).length)[0];
  const knownWrappedExport = /^ID_MEETING,/.test(firstLine) && /^"\d+,[^,]+,[^,]+,/.test(text.slice(firstLine.length).trimStart());
  let rows: string[][];
  try {
    rows = knownWrappedExport ? [] : readCsv(text, delimiter);
  } catch (error) {
    if (!/^ID_MEETING,/.test(firstLine)) throw error;
    rows = [];
  }
  // The supplied export wraps individual physical lines in another CSV quote layer.
  // Apply its repair only after a conventional parse failed to match that known header.
  if (/^ID_MEETING,/.test(firstLine) && (!rows.length || rows.some((row) => row.length !== rows[0].length))) {
    const repaired = text.split(/\r\n|\r|\n/).map((line) => (
      line.startsWith('"') && line.endsWith('"') ? line.slice(1, -1).replace(/""/g, '"') : line
    )).join("\n");
    rows = readCsv(repaired, delimiter);
    warnings.push("O encapsulamento de aspas do CSV foi normalizado para leitura. O arquivo original foi preservado.");
  }
  if (rows.length < 2) throw new Error("O CSV deve conter um cabeçalho e pelo menos uma reunião.");
  const headers = rows[0].map((header) => header.trim());
  if (new Set(headers).size !== headers.length || headers.some((header) => !header)) {
    throw new Error("O CSV contém nomes de coluna vazios ou repetidos.");
  }
  return rows.slice(1).map((values, index) => {
    if (values.length !== headers.length) {
      return { __importError: `O registro ${index + 1} não corresponde às colunas do CSV.` };
    }
    return Object.fromEntries(headers.map((header, index) => [header, values[index]]));
  });
}

function importDate(value: string | undefined): string | undefined {
  if (!value) return undefined;
  // Source timestamps without an offset are Brazilian meeting times, never browser-local.
  const match = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?)(Z|[+-]\d{2}:\d{2})?$/.exec(value);
  if (!match) throw new Error("Data inválida. Use AAAA-MM-DD HH:mm:ss ou ISO 8601.");
  const clock = match[2].split(":").map((part) => Number(part.split(".")[0]));
  if (clock[0] > 23 || clock[1] > 59 || (clock[2] ?? 0) > 59) throw new Error("Horário de reunião inválido.");
  const result = `${match[1]}T${match[2]}${match[3] ?? "-03:00"}`;
  const time = Date.parse(result);
  const calendar = new Date(`${match[1]}T00:00:00Z`);
  if (!Number.isFinite(time) || !Number.isFinite(calendar.getTime()) || calendar.toISOString().slice(0, 10) !== match[1]) {
    throw new Error("Data de reunião inválida.");
  }
  return result;
}

const METADATA_FIELDS: Record<string, string> = {
  FORMATO_MEETING: "meetingFormat", STATUS_MEETING: "sourceStatus", DURACAO_MEETING: "sourceDuration",
  TP_RECURSO: "customerType", FLG_EXTERNO: "externalMeeting", UF: "state", CNAE: "industryCode",
  NOME_UNIDADE: "salesUnit", NOME_SEGMENTO: "segment", FAIXA_FATURAMENTO_CLIENTE_EC: "revenueRange",
  FAIXA_FATURAMENTO_CLIENTE: "revenueRange", DT_ULTIMA_PESQUISA: "surveyDate", NOTA_NPS: "surveyNps",
};

export async function parseTranscriptImport(file: File): Promise<TranscriptImport> {
  if (file.size > MAX_IMPORT_BYTES) throw new Error("O arquivo de importação deve ter até 64 MB.");
  if (!/\.(json|jsonl|ndjson|csv)$/i.test(file.name)) throw new Error("Selecione um arquivo JSON, JSONL ou CSV.");
  const warnings: string[] = [];
  const bytes = await file.arrayBuffer();
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    const data = new Uint8Array(bytes);
    if ((data[0] === 0xff && data[1] === 0xfe) || (data[0] === 0xfe && data[1] === 0xff)) {
      text = new TextDecoder(data[0] === 0xff ? "utf-16le" : "utf-16be").decode(bytes);
    } else {
      text = new TextDecoder("utf-8").decode(bytes);
      warnings.push("O arquivo contém caracteres com codificação inválida. Confira os trechos marcados com � na prévia.");
    }
  }
  text = text.replace(/^\uFEFF/, "").trim();
  if (!text) throw new Error("O arquivo está vazio.");
  const sourceRows = /\.csv$/i.test(file.name) ? csvRows(text, warnings) : readJson(text);
  if (sourceRows.length > MAX_IMPORT_ROWS) throw new Error(`O arquivo deve conter no máximo ${MAX_IMPORT_ROWS} registros.`);
  const result: TranscriptImport = { records: [], issues: [], duplicates: 0, totalRows: sourceRows.length, warnings };
  const seen = new Map<string, string>();
  for (const [index, value] of sourceRows.entries()) {
    try {
      if (!isObject(value)) throw new Error("O registro deve ser um objeto de reunião.");
      if (value.__importError) throw new Error(String(value.__importError));
      const rawText = field(value, "ANON_TRANSCRICAO", "transcript", "transcription", "text");
      if (!rawText) throw new Error("Transcrição não informada (ANON_TRANSCRICAO, transcript ou text).");
      const transcript = rawText.replace(/\r\n|\r/g, "\n");
      if (transcript.length > MAX_TRANSCRIPT_CHARACTERS) throw new Error("A transcrição excede 1.000.000 de caracteres.");
      const contentHash = await digest(normalizedText(transcript));
      const sourceId = field(value, "ID_MEETING", "externalId", "id") ?? contentHash;
      if (sourceId.length > 200) throw new Error("O identificador da reunião excede 200 caracteres.");
      if (seen.has(sourceId)) {
        if (seen.get(sourceId) !== contentHash) throw new Error(`O ID ${sourceId} aparece com transcrições diferentes. Confira a origem.`);
        result.duplicates++;
        continue;
      }
      const clientCode = field(value, "CODT", "clientCode");
      if (clientCode && clientCode.length > 120) throw new Error("O código do cliente excede 120 caracteres.");
      const startedAt = importDate(field(value, "DT_MEETING", "startedAt", "date"));
      let endedAt = importDate(field(value, "endedAt"));
      const duration = field(value, "DURACAO_MEETING");
      if (!endedAt && startedAt && duration && /^\d{1,3}:\d{2}:\d{2}$/.test(duration)) {
        const [hours, minutes, seconds] = duration.split(":").map(Number);
        if (minutes < 60 && seconds < 60) endedAt = new Date(Date.parse(startedAt) + (hours * 3600 + minutes * 60 + seconds) * 1000).toISOString();
      }
      if (startedAt && endedAt && Date.parse(endedAt) < Date.parse(startedAt)) throw new Error("O término da reunião é anterior ao início.");
      const attributes: Record<string, string> = { externalId: sourceId, importSource: "transcript-file" };
      if (clientCode) attributes.clientCode = clientCode;
      for (const [source, target] of Object.entries(METADATA_FIELDS)) {
        const metadata = field(value, source);
        if (metadata) attributes[target] = metadata.slice(0, 256);
      }
      const title = field(value, "title", "TITULO", "NOME_MEETING") ?? `Reunião ${sourceId}${clientCode ? ` · ${clientCode}` : ""}`;
      const idempotencyKey = `import:v1:${await digest(JSON.stringify([sourceId, contentHash]))}`;
      result.records.push({ sourceId, clientCode, title: title.slice(0, 200), text: transcript, startedAt, endedAt, attributes, idempotencyKey });
      seen.set(sourceId, contentHash);
    } catch (error) {
      result.issues.push({ row: index + 1, message: error instanceof Error ? error.message : "Registro inválido." });
    }
  }
  return result;
}
