// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { LlmModel, ServiceBinding } from "@/lib/contracts";
import { ModelsClient } from "./models-client";

const actions = vi.hoisted(() => ({
  addModelAction: vi.fn(),
  bindServiceAction: vi.fn(),
  removeModelAction: vi.fn(),
}));
vi.mock("./actions", () => actions);

const MODEL: LlmModel = {
  id: "model-1", provider: "openai", model: "test-model", label: "Existing model",
  modality: "text", inputCostPer1M: 1, outputCostPer1M: 2, supportsStrictJsonSchema: true,
};
const BINDING: ServiceBinding = { service: "chat", modelId: MODEL.id, enabled: true };

beforeEach(() => vi.resetAllMocks());
afterEach(cleanup);

function fillModelForm() {
  fireEvent.click(screen.getByRole("button", { name: "+ Adicionar modelo" }));
  fireEvent.change(screen.getByPlaceholderText("provider (ex.: openai)"), { target: { value: "openai" } });
  fireEvent.change(screen.getByPlaceholderText("model (ex.: gpt-4o-mini)"), { target: { value: "new-model" } });
  fireEvent.change(screen.getByPlaceholderText("nome amigável (ex.: GPT-4o mini)"), { target: { value: "New model" } });
  fireEvent.change(screen.getByPlaceholderText("base URL do provider (ex.: https://api.openai.com/v1)"), {
    target: { value: "https://api.example.test/v1" },
  });
}

describe("model catalog interactions", () => {
  it("shows a newly saved model in the catalog and binding options without reloading", async () => {
    const created = { ...MODEL, id: "model-2", model: "new-model", label: "New model" };
    actions.addModelAction.mockResolvedValue({ ok: true, value: created });
    render(<ModelsClient initialModels={[MODEL]} initialBindings={[BINDING]} />);
    fillModelForm();
    fireEvent.click(screen.getByRole("button", { name: "Salvar modelo" }));

    await screen.findByText('Modelo "New model" adicionado ao catálogo.');
    expect(screen.getAllByRole("button", { name: "Remover" })).toHaveLength(2);
    const chat = screen.getAllByRole("combobox")[0];
    expect(within(chat).getByRole("option", { name: "New model" }).getAttribute("value")).toBe(created.id);
  });

  it("creates the first binding and uses the server's enabled state", async () => {
    actions.bindServiceAction.mockResolvedValue({ ok: true, value: { ...BINDING, enabled: false } });
    render(<ModelsClient initialModels={[MODEL]} initialBindings={[]} />);
    const chat = screen.getAllByRole("combobox")[0] as HTMLSelectElement;
    fireEvent.change(chat, { target: { value: MODEL.id } });

    await waitFor(() => expect(chat.value).toBe(MODEL.id));
    expect(actions.bindServiceAction).toHaveBeenCalledWith("chat", MODEL.id, true);
    const row = chat.parentElement!;
    fireEvent.click(within(row).getByRole("button", { name: "Desligado" }));
    await waitFor(() => expect(actions.bindServiceAction).toHaveBeenLastCalledWith("chat", MODEL.id, true));
    expect(actions.bindServiceAction).toHaveBeenCalledTimes(2);
  });

  it("keeps a bound model and explains why removal was refused", async () => {
    render(<ModelsClient initialModels={[MODEL]} initialBindings={[BINDING]} />);
    fireEvent.click(screen.getByRole("button", { name: "Remover" }));
    expect(screen.getByText(/Não dá pra remover um modelo em uso/)).toBeTruthy();
    expect(actions.removeModelAction).not.toHaveBeenCalled();
  });

  it("recovers the add form after a server-action transport failure", async () => {
    actions.addModelAction.mockRejectedValue(new Error("Connection lost"));
    render(<ModelsClient initialModels={[MODEL]} initialBindings={[]} />);
    fillModelForm();
    fireEvent.click(screen.getByRole("button", { name: "Salvar modelo" }));

    await screen.findByText(/Falha ao adicionar: Connection lost/);
    expect((screen.getByRole("button", { name: "Salvar modelo" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("removes an unused model from the catalog and binding options", async () => {
    actions.removeModelAction.mockResolvedValue({ ok: true, value: undefined });
    render(<ModelsClient initialModels={[MODEL]} initialBindings={[]} />);
    fireEvent.click(screen.getByRole("button", { name: "Remover" }));
    await screen.findByText("Modelo removido do catálogo.");
    expect(screen.queryByRole("button", { name: "Remover" })).toBeNull();
    expect(screen.queryByRole("option", { name: MODEL.label })).toBeNull();
  });

  it("refuses an analysis model that does not support strict JSON", () => {
    render(<ModelsClient initialModels={[{ ...MODEL, supportsStrictJsonSchema: false }]} initialBindings={[]} />);
    fireEvent.change(screen.getByRole("combobox", { name: "Modelo para Análise de reunião" }), {
      target: { value: MODEL.id },
    });
    expect(screen.getByText(/não suporta JSON Schema strict/)).toBeTruthy();
    expect(actions.bindServiceAction).not.toHaveBeenCalled();
  });

  it("keeps the previous binding and releases the controls after a transport failure", async () => {
    actions.bindServiceAction.mockRejectedValue(new Error("Connection lost"));
    render(<ModelsClient initialModels={[MODEL]} initialBindings={[BINDING]} />);
    fireEvent.click(screen.getByRole("button", { name: "Ativo" }));
    await screen.findByText("Falha ao alternar: Connection lost");
    expect((screen.getByRole("button", { name: "Ativo" }) as HTMLButtonElement).disabled).toBe(false);
    expect((screen.getByRole("combobox", { name: "Modelo para Chat IA (Core)" }) as HTMLSelectElement).value).toBe(MODEL.id);
  });
});
