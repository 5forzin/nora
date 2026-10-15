import { webcrypto } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MAX_IMPORT_BYTES, MAX_IMPORT_ROWS, parseTranscriptImport } from "./transcript-import";

function source(text: string, name = "meetings.json"): File {
  const encoded = new TextEncoder().encode(text);
  return { name, size: encoded.length, arrayBuffer: async () => encoded.buffer } as File;
}

const transcript = "[LOCUTOR 1]: Precisamos avaliar a integração antes de aprovar a proposta.";
const row = { ID_MEETING: "123", CODT: " CLIENT-1 ", DT_MEETING: "2026-03-10 15:30:00", DURACAO_MEETING: "00:30:00", ANON_TRANSCRICAO: transcript };

beforeEach(() => vi.stubGlobal("crypto", webcrypto));
afterEach(() => vi.unstubAllGlobals());

describe("structured transcript imports", () => {
  it("preserves source identity, client and Brazilian meeting dates without treating revenue or NPS as transcript content", async () => {
    const result = await parseTranscriptImport(source(JSON.stringify([{ ...row, NOTA_NPS: 9, FAIXA_FATURAMENTO_CLIENTE_EC: "120 million" }])));
    expect(result.issues).toEqual([]);
    expect(result.records[0]).toMatchObject({ sourceId: "123", clientCode: "CLIENT-1", text: transcript, startedAt: "2026-03-10T15:30:00-03:00", endedAt: "2026-03-10T19:00:00.000Z", attributes: { externalId: "123", clientCode: "CLIENT-1", surveyNps: "9", revenueRange: "120 million" } });
    expect(result.records[0].idempotencyKey).toMatch(/^import:v1:[a-f0-9]{64}$/);
  });

  it("reads JSONL and drops repeated source IDs but keeps identical text from distinct meetings", async () => {
    const result = await parseTranscriptImport(source([row, row, { ...row, ID_MEETING: "456" }].map((value) => JSON.stringify(value)).join("\n"), "export.jsonl"));
    expect(result.records).toHaveLength(2);
    expect(result.duplicates).toBe(1);
    expect(result.totalRows).toBe(3);
  });

  it("reports conflicting duplicate IDs without replacing the first transcript", async () => {
    const result = await parseTranscriptImport(source(JSON.stringify([row, { ...row, ANON_TRANSCRICAO: "Outra conversa" }])));
    expect(result.records).toHaveLength(1);
    expect(result.duplicates).toBe(0);
    expect(result.issues[0]).toMatchObject({ row: 2 });
    expect(result.issues[0].message).toContain("transcrições diferentes");
  });

  it.each(["records", "meetings", "data"])("accepts a %s envelope", async (key) => {
    expect((await parseTranscriptImport(source(JSON.stringify({ [key]: [row] })))).records).toHaveLength(1);
  });

  it("reads ordinary quoted CSV with embedded commas, quotes and newlines", async () => {
    const text = 'ID_MEETING,CODT,ANON_TRANSCRICAO\r\n123,CLIENT-1,"Primeira fala, com vírgula.\r\nA proposta diz ""a confirmar""."';
    const result = await parseTranscriptImport(source(text, "meetings.csv"));
    expect(result.issues).toEqual([]);
    expect(result.warnings).toEqual([]);
    expect(result.records[0].text).toBe('Primeira fala, com vírgula.\nA proposta diz "a confirmar".');
  });

  it("repairs the supplied physical-line quoting without changing the source", async () => {
    const text = 'ID_MEETING,CODT,ANON_TRANSCRICAO\r\r\n"123,CLIENT-1,""Primeira fala, com vírgula."\r\r\n[LOCUTOR 2]: Ainda estamos avaliando.\r\r\n"[LOCUTOR 1]: Vou enviar a proposta."""';
    const result = await parseTranscriptImport(source(text, "meetings.csv"));
    expect(result.issues).toEqual([]);
    expect(result.records).toHaveLength(1);
    expect(result.records[0].text).toContain("Vou enviar a proposta.");
    expect(result.warnings[0]).toContain("aspas");
  });

  it("accepts semicolon CSV and a UTF-8 BOM", async () => {
    const result = await parseTranscriptImport(source('\uFEFFid;clientCode;text\n123;ABC;Uma transcrição comercial', "meetings.csv"));
    expect(result.records[0]).toMatchObject({ sourceId: "123", clientCode: "ABC" });
  });

  it("reuses the same idempotency key across file formats and insignificant whitespace", async () => {
    const one = await parseTranscriptImport(source(JSON.stringify(row)));
    const two = await parseTranscriptImport(source(`ID_MEETING,CODT,DT_MEETING,DURACAO_MEETING,ANON_TRANSCRICAO\n123,CLIENT-1,2026-03-10 15:30:00,00:30:00,"${transcript.replace(" ", "  ")}"`, "meetings.csv"));
    expect(one.records[0].idempotencyKey).toBe(two.records[0].idempotencyKey);
  });

  it("isolates invalid records and rejects impossible dates", async () => {
    const result = await parseTranscriptImport(source(JSON.stringify([row, { id: "missing" }, { ...row, ID_MEETING: "789", DT_MEETING: "2026-02-30 15:00:00" }, null])));
    expect(result.records).toHaveLength(1);
    expect(result.issues.map((issue) => issue.row)).toEqual([2, 3, 4]);
  });

  it("preserves ISO timestamps with fractional seconds", async () => {
    const result = await parseTranscriptImport(source(JSON.stringify({ ...row, DT_MEETING: "2026-03-10T15:30:59.123Z" })));
    expect(result.issues).toEqual([]);
    expect(result.records[0].startedAt).toBe("2026-03-10T15:30:59.123Z");
  });

  it("rejects a malformed JSONL before producing a partial import", async () => {
    await expect(parseTranscriptImport(source(`${JSON.stringify(row)}\n{broken}`, "meetings.jsonl"))).rejects.toThrow("linha 2");
  });

  it("rejects oversized files, excessive records and missing CSV headers", async () => {
    await expect(parseTranscriptImport({ name: "big.json", size: MAX_IMPORT_BYTES + 1 } as File)).rejects.toThrow("64 MB");
    await expect(parseTranscriptImport(source(JSON.stringify(Array.from({ length: MAX_IMPORT_ROWS + 1 }, () => row))))).rejects.toThrow("2000");
    await expect(parseTranscriptImport(source("id,,text\n123,ABC,Test", "meetings.csv"))).rejects.toThrow("nomes de coluna");
  });
});
