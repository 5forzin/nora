"use strict";

(() => {
  const element = (id) => document.getElementById(id);
  const apiBase = new URL("./api/", window.location.href);
  const activeStatuses = new Set(["queued", "dispatched", "running", "stopping"]);
  const statusLabels = { idle: "Pronto", queued: "Na fila", dispatched: "Iniciando", running: "Em execução", stopping: "Parando…", completed: "Concluída", succeeded: "Concluída", failed: "Falhou", stopped: "Parada" };
  const executionMessages = {
    Stopped: "Execução parada.",
    "Stopped before dispatch": "Etapa parada antes de iniciar.",
    "Stop requested": "Parada solicitada. Aguardando o notebook.",
    "Controller restarted; rerun this step manually": "O controle reiniciou. Confira a etapa antes de executá-la novamente.",
    "Agent restarted; rerun this step manually": "O agente do notebook reiniciou. Confira a etapa antes de executá-la novamente.",
  };
  const errorLabels = {
    BUSY: "Uma etapa ainda está em execução.",
    AGENT_OFFLINE: "O notebook está desconectado.",
    SCRIPT_BOUNDARY: "Não há outra etapa nessa direção.",
    UNKNOWN_STEP: "Esta etapa não está disponível. Atualize o controle.",
    LOGIN_RATE_LIMITED: "Muitas tentativas. Aguarde antes de entrar novamente.",
    CONTROL_HISTORY_LIMIT: "O limite desta sessão foi atingido.",
    ORIGIN_OR_CONTROL_HEADER_REQUIRED: "Acesso recusado. Reabra o endereço do controle.",
  };
  let authenticated = false;
  let state = null;
  let mode = "control";
  let readIndex = 0;
  let selectedIndex = null;
  let online = false;
  let commandPending = false;
  let stopPending = false;
  let speedPending = false;
  let loginPending = false;
  let logoutPending = false;
  let authVersion = 0;
  let guideVisited = false;
  let pollTimer;
  let stateRequest;
  let listSignature = "";

  function message(id, text) {
    element(id).textContent = text || "";
    element(id).hidden = !text;
  }

  async function request(path, data) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    try {
      const response = await fetch(new URL(path, apiBase), {
        method: data === undefined ? "GET" : "POST",
        credentials: "same-origin",
        cache: "no-store",
        headers: data === undefined ? {} : { "Content-Type": "application/json", "X-Presentation-Control": "1" },
        body: data === undefined ? undefined : JSON.stringify(data),
        signal: controller.signal,
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        const error = new Error(typeof body.message === "string" ? body.message : errorLabels[body.error] || "Não foi possível concluir o pedido.");
        error.status = response.status;
        throw error;
      }
      return body;
    } finally {
      clearTimeout(timer);
    }
  }

  function showLogin(error = "") {
    authVersion++;
    authenticated = false;
    state = null;
    online = false;
    commandPending = false;
    stopPending = false;
    speedPending = false;
    stateRequest = null;
    guideVisited = false;
    selectedIndex = null;
    clearTimeout(pollTimer);
    element("boot").hidden = true;
    element("remote").hidden = true;
    element("logout").hidden = true;
    element("login").hidden = false;
    message("login-error", error);
  }

  function notes(target, value) {
    const lines = Array.isArray(value) ? value : [value];
    const text = lines.filter((line) => typeof line === "string" && line.trim());
    const container = element(target);
    const signature = JSON.stringify(text);
    if (container.dataset.content === signature) return text.length > 0;
    container.replaceChildren(...text.map((line) => {
      const paragraph = document.createElement("p");
      paragraph.textContent = line;
      return paragraph;
    }));
    container.dataset.content = signature;
    return text.length > 0;
  }

  function render() {
    if (!state || !authenticated) return;
    const steps = state.steps;
    const current = state.currentIndex;
    const status = state.execution?.status || "idle";
    const running = activeStatuses.has(status);
    const connected = online && state.agent?.connected === true;
    const blocked = !connected || commandPending || stopPending || speedPending || logoutPending || running;
    const guide = mode === "guide";
    readIndex = Math.min(Math.max(readIndex, 0), Math.max(0, steps.length - 1));
    const index = guide ? readIndex : Math.max(current, 0);
    const step = steps[index];
    element("speed").disabled = speedPending || logoutPending;
    if (!speedPending) element("speed").value = String([0.5, 1, 1.5, 2].includes(state.speed) ? state.speed : 1);

    element("connection-dot").classList.toggle("connected", connected);
    element("connection-label").textContent = !online ? "Sem conexão com o controle" : connected ? "Notebook conectado" : "Notebook desconectado";
    const lastSeen = state.agent?.lastSeen;
    const seen = lastSeen ? new Date(typeof lastSeen === "number" ? lastSeen * 1000 : lastSeen) : null;
    element("last-seen").textContent = !connected && seen && Number.isFinite(seen.getTime()) ? seen.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" }) : "";
    element("step-counter").textContent = !steps.length ? "Roteiro vazio" : !guide && current < 0 ? "Pronto para começar" : `Etapa ${index + 1} de ${steps.length}`;
    element("step-title").textContent = step?.title || "Nenhuma etapa disponível";
    element("execution-label").textContent = guide ? "Só leitura" : statusLabels[status] || (state.paused ? "Pausado" : "Aguardando estado");
    element("execution-label").className = `status-label${!guide && running ? " running" : !guide && status === "failed" ? " failed" : ""}`;
    message("step-action", typeof step?.action === "string" ? step.action : "");
    message("execution-message", guide ? "" : executionMessages[state.execution?.message] || state.execution?.message);
    element("notes-section").hidden = !notes("step-notes", step?.notes);
    element("step-total").textContent = String(steps.length);
    element("automatic-controls").hidden = guide;
    element("guide-controls").hidden = !guide;
    element("next").disabled = blocked || !steps.length || current >= steps.length - 1;
    element("previous").disabled = blocked || current <= 0;
    element("stop").disabled = stopPending || logoutPending || !steps.length;
    element("stop-label").textContent = stopPending ? "Parando…" : "Parar";
    element("guide-previous").disabled = readIndex <= 0;
    element("guide-next").disabled = readIndex >= steps.length - 1;

    const signature = JSON.stringify(steps.map((item) => [item.id, item.title]));
    if (listSignature !== signature) {
      const list = element("steps");
      list.replaceChildren(...steps.map((item, itemIndex) => {
        const row = document.createElement("li");
        const button = document.createElement("button");
        const number = document.createElement("span");
        const title = document.createElement("span");
        number.className = "step-number";
        number.textContent = String(itemIndex + 1).padStart(2, "0");
        title.textContent = item.title;
        button.type = "button";
        button.append(number, title);
        button.addEventListener("click", () => {
          if (mode === "guide") readIndex = itemIndex;
          else selectedIndex = itemIndex;
          render();
        });
        row.append(button);
        return row;
      }));
      listSignature = signature;
    }
    Array.from(element("steps").querySelectorAll("button")).forEach((button, itemIndex) => {
      button.setAttribute("aria-current", itemIndex === (guide ? readIndex : current) ? "step" : "false");
      button.setAttribute("aria-pressed", String(!guide && selectedIndex === itemIndex));
    });
    const selected = selectedIndex === null ? null : steps[selectedIndex];
    element("selection").hidden = guide || !selected;
    if (selected) {
      element("selection-title").textContent = selected.title;
      notes("selection-notes", selected.notes);
      element("run").disabled = blocked;
    }
  }

  function applyState(value) {
    if (!Array.isArray(value.steps) || !Number.isInteger(value.currentIndex) || value.currentIndex < -1 || value.currentIndex >= value.steps.length || value.steps.some((step) => !step || typeof step.id !== "string" || typeof step.title !== "string")) throw new Error("O estado recebido está incompleto.");
    if (state && state.sessionId !== value.sessionId) { readIndex = 0; selectedIndex = null; guideVisited = false; }
    state = value;
    online = true;
    authenticated = true;
    element("boot").hidden = true;
    element("login").hidden = true;
    element("remote").hidden = false;
    element("logout").hidden = false;
    render();
  }

  function readState() {
    if (stateRequest) return stateRequest;
    const version = authVersion;
    const pending = request("state").then((value) => {
      if (version === authVersion) applyState(value);
    }).finally(() => { if (stateRequest === pending) stateRequest = null; });
    stateRequest = pending;
    return stateRequest;
  }

  function schedulePoll() {
    clearTimeout(pollTimer);
    if (authenticated && !logoutPending) pollTimer = setTimeout(poll, 1000);
  }

  async function poll() {
    const version = authVersion;
    try {
      await readState();
    } catch (error) {
      if (version !== authVersion) return;
      if (error.status === 401) showLogin("Sua sessão expirou. Entre novamente.");
      else { online = false; render(); }
    } finally {
      schedulePoll();
    }
  }

  async function command(action, stepId) {
    if (!authenticated || logoutPending || (action === "stop" ? stopPending : commandPending || stopPending)) return;
    if (action !== "stop" && (mode !== "control" || speedPending || !online || !state?.agent?.connected || activeStatuses.has(state?.execution?.status))) return;
    const version = authVersion;
    if (action === "stop") stopPending = true;
    else commandPending = true;
    message("error-banner", "");
    render();
    try {
      await request("command", { action, ...(stepId ? { stepId } : {}), requestId: crypto.randomUUID() });
      if (version !== authVersion) return;
      // Discard a pre-command poll before requesting the acknowledged state.
      if (stateRequest) await stateRequest.catch(() => {});
      if (version !== authVersion) return;
      await readState();
    } catch (error) {
      if (version !== authVersion) return;
      if (error.status === 401) showLogin("Sua sessão expirou. Entre novamente.");
      else {
        if (!error.status) online = false;
        message("error-banner", error.status ? error.message : "Comando sem confirmação. Confira o estado antes de repetir.");
      }
    } finally {
      if (version === authVersion) {
        if (action === "stop") stopPending = false;
        else commandPending = false;
        render();
        schedulePoll();
      }
    }
  }

  element("login-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    if (loginPending) return;
    loginPending = true;
    element("login-submit").disabled = true;
    element("login-submit").textContent = "Entrando…";
    message("login-error", "");
    try {
      await request("login", { username: element("username").value.trim(), password: element("password").value });
      element("password").value = "";
      await readState();
      schedulePoll();
    } catch (error) {
      showLogin(error.status === 401 ? "Usuário ou senha incorretos." : error.status ? error.message : "Não foi possível entrar. Tente novamente.");
    } finally {
      loginPending = false;
      element("login-submit").disabled = false;
      element("login-submit").textContent = "Entrar";
    }
  });
  element("speed").addEventListener("change", async () => {
    if (!authenticated || logoutPending || speedPending) return;
    const speed = Number(element("speed").value);
    if (![0.5, 1, 1.5, 2].includes(speed)) return;
    const version = authVersion;
    speedPending = true;
    message("error-banner", "");
    render();
    try {
      const result = await request("speed", { speed });
      if (version !== authVersion) return;
      if (stateRequest) await stateRequest.catch(() => {});
      if (version !== authVersion) return;
      state.speed = result.speed;
      await readState();
    } catch (error) {
      if (version !== authVersion) return;
      if (error.status === 401) showLogin("Sua sessão expirou. Entre novamente.");
      else message("error-banner", error.status ? error.message : "Não foi possível confirmar a velocidade. Confira o valor antes de continuar.");
    } finally {
      if (version === authVersion) { speedPending = false; render(); schedulePoll(); }
    }
  });
  element("logout").addEventListener("click", async () => {
    if (logoutPending) return;
    logoutPending = true;
    authVersion++;
    stateRequest = null;
    clearTimeout(pollTimer);
    element("logout").disabled = true;
    render();
    try { await request("logout", {}); showLogin(); }
    catch { message("error-banner", "Não foi possível sair. Tente novamente."); }
    finally { logoutPending = false; commandPending = false; stopPending = false; speedPending = false; element("logout").disabled = false; render(); schedulePoll(); }
  });
  document.querySelectorAll('input[name="mode"]').forEach((input) => input.addEventListener("change", () => {
    mode = input.value;
    if (mode === "guide" && !guideVisited) { readIndex = Math.max(state?.currentIndex ?? 0, 0); guideVisited = true; }
    render();
  }));
  element("next").addEventListener("click", () => command("next"));
  element("previous").addEventListener("click", () => command("previous"));
  element("stop").addEventListener("click", () => command("stop"));
  element("run").addEventListener("click", () => {
    const selected = state?.steps[selectedIndex];
    if (selected) command("run", selected.id);
  });
  element("guide-previous").addEventListener("click", () => { readIndex--; render(); });
  element("guide-next").addEventListener("click", () => { readIndex++; render(); });
  document.addEventListener("visibilitychange", () => { if (!document.hidden && authenticated) { clearTimeout(pollTimer); void poll(); } });
  readState().then(schedulePoll).catch((error) => showLogin(error.status === 401 ? "" : "Não foi possível conectar. Tente entrar novamente."));
})();
