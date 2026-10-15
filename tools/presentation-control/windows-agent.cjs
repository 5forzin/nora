'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');
const readline = require('node:readline');
const { randomUUID } = require('node:crypto');
const { AsyncLocalStorage } = require('node:async_hooks');

const ROOT = path.resolve(__dirname, '../..');
const WEB = 'https://nora.systems';
const QUESTION = 'Faça uma consolidação para o diretor das três reuniões da Aster: qual é a situação atual do orçamento, da entrega e da liberação do piloto? Diferencie os fatos antigos dos atuais, cite as três reuniões e liste as pendências com responsável e prazo, excluindo a revisão financeira já concluída.';
const ALLOWED_STEPS = new Set(['opening', 'import-preview', 'import-send', 'quality', 'evidence', 'history', 'task-edit', 'task-done', 'chat-ask', 'chat-sources', 'executive', 'closing']);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function visibleError(error) {
  const message = String(error.message);
  if (/locator\.|Timeout.*exceeded|waiting for locator/i.test(message)) return 'A tela esperada não ficou disponível. Confira o notebook antes de continuar.';
  if (/page\.goto|net::|ECONN|fetch failed/i.test(message)) return 'Não foi possível abrir a página. Confira a conexão e a tela atual.';
  if (/Target.*closed|context.*closed|browser.*closed/i.test(message)) return 'A janela foi fechada. Reabra o navegador da apresentação.';
  return message.slice(0, 350);
}

class Stopped extends Error {
  constructor() { super('Interrompido. Ações já enviadas ao NORA podem continuar processando.'); }
}

class NativeMouse {
  constructor(python) {
    this.child = spawn(python || 'python', ['-u', path.join(__dirname, 'native_mouse.py')], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    this.pending = [];
    this.child.on('error', (error) => { while (this.pending.length) this.pending.shift().reject(error); });
    this.child.on('exit', () => { while (this.pending.length) this.pending.shift().reject(new Error('O controle do mouse foi encerrado.')); });
    readline.createInterface({ input: this.child.stdout }).on('line', (line) => {
      const pending = this.pending.shift();
      if (!pending) return;
      try {
        const result = JSON.parse(line);
        result.ok ? pending.resolve(result.result) : pending.reject(new Error(result.error));
      } catch (error) { pending.reject(error); }
    });
  }
  call(action, input = {}) {
    return new Promise((resolve, reject) => {
      this.pending.push({ resolve, reject });
      this.child.stdin.write(JSON.stringify({ action, ...input }) + '\n');
    });
  }
  close() { this.child.kill(); }
}

class PresentationRunner {
  constructor(config, account) {
    this.config = config;
    this.account = account;
    this.runId = randomUUID();
    this.agentId = 'nora-presentation-windows';
    this.stopRequested = false;
    this.networkFailures = 0;
    this.native = new NativeMouse(config.python);
    this.stateFile = config.stateFile;
    this.pages = {};
    this.scope = new AsyncLocalStorage();
    this.persistQueue = Promise.resolve();
    this.speed = 1;
  }
  check() { if (this.stopRequested || this.scope.getStore()?.aborted) throw new Stopped(); }
  async persist() {
    const contents = JSON.stringify(this.state, null, 2);
    this.persistQueue = this.persistQueue.catch(() => {}).then(() => fs.writeFile(this.stateFile, contents));
    await this.persistQueue;
  }
  async call(endpoint, body) {
    const response = await fetch(this.config.controlUrl + '/api/agent/' + endpoint, {
      method: 'POST', headers: { Authorization: 'Bearer ' + this.config.agentToken, 'Content-Type': 'application/json' },
      body: JSON.stringify({ agentId: this.agentId, runId: this.runId, ...body }), signal: AbortSignal.timeout(6000),
    });
    if (!response.ok) throw new Error('Controle remoto indisponível (' + response.status + ').');
    return response.json();
  }
  async result(commandId, status, message) { return this.call('result', { commandId, status, message }); }
  async initialize() {
    await fs.mkdir(path.dirname(this.stateFile), { recursive: true });
    try { this.state = JSON.parse(await fs.readFile(this.stateFile, 'utf8')); } catch { this.state = { account: this.account.email, completed: {}, meetings: {} }; }
    if (this.state.account !== this.account.email) throw new Error('O perfil local pertence a outra conta.');
    const { chromium } = require('../../apps/web/node_modules/playwright');
    this.context = await chromium.launchPersistentContext(this.config.profileDir, {
      headless: false, viewport: null, acceptDownloads: false,
      chromiumSandbox: true,
      executablePath: this.config.browserPath || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
      args: ['--start-maximized', '--force-device-scale-factor=1', '--disable-save-password-bubble', '--no-first-run'],
      ignoreDefaultArgs: ['--enable-automation'],
    });
    this.browser = this.context.browser();
    const browserCdp = await this.browser.newBrowserCDPSession();
    const processes = await browserCdp.send('SystemInfo.getProcessInfo');
    this.browserPid = processes.processInfo.find((process) => process.type === 'browser').id;
    console.log('BROWSER PID ' + this.browserPid);
    await browserCdp.detach();
    this.page = this.context.pages()[0] || await this.context.newPage();
    const windowCdp = await this.context.newCDPSession(this.page);
    const browserWindow = await windowCdp.send('Browser.getWindowForTarget');
    await windowCdp.send('Browser.setWindowBounds', { windowId: browserWindow.windowId, bounds: { windowState: 'maximized' } });
    await windowCdp.detach();
    await this.native.call('focus', { pid: this.browserPid });
    this.pages.main = this.page;
    this.context.on('response', async (response) => {
      if (response.request().method() !== 'POST' || !/^https:\/\/api\.nora\.systems\/meetings(?:\?|$)/.test(response.url()) || !response.ok()) return;
      try {
        const record = await response.json();
        if (record?.id && typeof record.title === 'string') {
          this.state.meetings[record.title] = record.id;
          await this.persist();
        }
      } catch { /* A navigation can dispose of an observed response. */ }
    });
    this.page.on('dialog', async (dialog) => {
      // Only the import screen's known beforeunload prompt can be dismissed by the runner.
      if (dialog.type() === 'beforeunload') await dialog.dismiss();
    });
    await this.signIn(this.page);
    if (this.config.prepareCompany) await this.prepareCompany();
    await this.goto('/meetings/upload');
    await this.persist();
    console.log('READY: presentation browser authenticated; F8 interrupts automation.');
  }
  async signIn(page) {
    this.check();
    await page.goto(WEB + '/auth/login', { waitUntil: 'domcontentloaded', timeout: 25000 });
    this.check();
    const existing = (await page.context().cookies(WEB)).find((cookie) => cookie.name === 'nora_user');
    const loginVisible = await page.getByRole('button', { name: 'Entrar', exact: true }).isVisible().catch(() => false);
    if (existing && !decodeURIComponent(existing.value).includes(this.account.email) && !loginVisible) {
      const logout = page.locator('.side').getByRole('button', { name: 'Sair', exact: true });
      await logout.waitFor({ state: 'visible', timeout: 15000 });
      this.check();
      await logout.click();
      await page.getByRole('button', { name: 'Entrar', exact: true }).waitFor({ timeout: 15000 });
    }
    if (await page.getByRole('button', { name: 'Entrar', exact: true }).isVisible().catch(() => false)) {
      this.check();
      await page.getByLabel('E-mail', { exact: true }).fill(this.account.email);
      this.check();
      await page.getByLabel('Senha', { exact: true }).fill(this.account.password);
      this.check();
      await page.getByRole('button', { name: 'Entrar', exact: true }).click();
      await page.waitForURL((url) => !url.pathname.startsWith('/auth/'), { timeout: 20000 });
    }
    await page.locator('.side').waitFor({ state: 'visible', timeout: 20000 });
    this.check();
    const userCookie = (await page.context().cookies(WEB)).find((cookie) => cookie.name === 'nora_user');
    if (!userCookie || !decodeURIComponent(userCookie.value).includes(this.account.email)) throw new Error('A conta aberta não corresponde à conta configurada.');
  }
  async goto(route, page = this.page) {
    this.check();
    if (!/^\/(dashboard|meetings(?:\/upload|\/[a-f0-9-]+)?|enterprise(?:\/company)?|tasks(?:\?meetingId=[a-f0-9-]+(?:#task-[a-f0-9-]+)?)?|chat(?:\?.*)?)$/.test(route)) throw new Error('Destino fora do roteiro.');
    await page.bringToFront();
    this.check();
    if (page.url() !== WEB + route) {
      const options = { waitUntil: 'domcontentloaded', timeout: 20000 };
      try { await page.goto(WEB + route, options); }
      catch (error) {
        this.check();
        if (!/net::ERR_CONNECTION_(CLOSED|RESET)\b/.test(String(error.message))) throw error;
        await sleep(450);
        this.check();
        await page.goto(WEB + route, options);
      }
    }
    if (route.startsWith('/chat')) await page.getByRole('textbox', { name: 'Pergunte qualquer coisa para a Nora', exact: true }).waitFor({ timeout: 20000 });
    else await page.locator('h1').first().waitFor({ timeout: 20000 });
    this.check();
  }
  async focus(page = this.page) {
    this.check();
    await page.bringToFront();
    return this.native.call('focus', { pid: this.browserPid });
  }
  async smoothClick(locator, page = this.page, nativePid = this.browserPid, nativeTitle = undefined) {
    this.check();
    await locator.waitFor({ state: 'visible', timeout: 15000 });
    this.check();
    await locator.scrollIntoViewIfNeeded({ timeout: 8000 });
    this.check();
    await page.bringToFront();
    this.check();
    await this.native.call('focus', { pid: nativePid, title: nativeTitle });
    const rect = await locator.boundingBox();
    if (!rect) throw new Error('O botão esperado não está visível.');
    const dimensions = await page.evaluate(() => ({ x: window.screenX, y: window.screenY, outerWidth: window.outerWidth, innerWidth: window.innerWidth, outerHeight: window.outerHeight, innerHeight: window.innerHeight, ratio: window.devicePixelRatio }));
    const x = Math.round(dimensions.x + (dimensions.outerWidth - dimensions.innerWidth) / 2 + rect.x + rect.width / 2);
    const y = Math.round(dimensions.y + dimensions.outerHeight - dimensions.innerHeight - (dimensions.outerWidth - dimensions.innerWidth) / 2 + rect.y + rect.height / 2);
    const nativeTarget = { pid: nativePid, x, y };
    this.check();
    await this.native.call('move', { ...nativeTarget, duration: 0.42 / this.speed });
    await sleep(110 / this.speed);
    this.check();
    const targetStillPresent = await locator.evaluate((element, point) => {
      const hit = document.elementFromPoint(point.x, point.y);
      return !!hit && (element === hit || element.contains(hit));
    }, { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 });
    if (!targetStillPresent) throw new Error('A tela mudou antes do clique. Execute a etapa novamente.');
    await this.native.call('click', nativeTarget);
    await sleep(220 / this.speed);
    this.check();
  }
  async fill(locator, value, page = this.page) {
    await this.smoothClick(locator, page);
    const type = await locator.getAttribute('type');
    this.check();
    if (type === 'date' || type === 'datetime-local') await locator.fill(value);
    else {
      const field = await locator.elementHandle();
      if (!field) throw new Error('O campo esperado não está disponível.');
      await field.fill('');
      for (let offset = 0; offset < value.length; offset += 12) {
        this.check();
        if (!await field.evaluate((element) => element === document.activeElement)) throw new Error('O foco mudou durante a digitação. Confira a tela antes de continuar.');
        await field.type(value.slice(offset, offset + 12), { delay: Math.round(18 / this.speed) });
      }
    }
    this.check();
  }
  async scrollTo(locator, page = this.page) {
    this.check();
    await locator.waitFor({ state: 'visible', timeout: 15000 });
    await page.bringToFront();
    await locator.evaluate((element) => element.scrollIntoView({ behavior: 'smooth', block: 'center' }));
    await sleep(Math.max(450, 650 / this.speed));
    this.check();
  }
  async prepareCompany() {
    await this.goto('/enterprise/company');
    const company = this.page.locator('#ctx-company');
    await company.waitFor({ state: 'visible' });
    const current = await company.inputValue();
    if (current.trim() && current !== 'TOTVS') {
      throw new Error('Já existe um contexto de empresa diferente.');
    }
    if (current === 'TOTVS' && await this.page.getByLabel('Nome do produto', { exact: true }).count() === 2 && await this.page.locator('#ctx-industry').inputValue()) {
      return;
    }
    await this.fill(company, 'TOTVS');
    await this.fill(this.page.locator('#ctx-industry'), 'Software de gestão empresarial');
    await this.fill(this.page.locator('#ctx-icp'), 'Empresas B2B que precisam integrar operação e finanças.');
    await this.fill(this.page.locator('#ctx-value'), 'Sistemas de gestão integrados para operações empresariais.');
    for (const [name, description] of [['Protheus', 'ERP para gestão empresarial.'], ['RM', 'Gestão empresarial e financeira.']]) {
      await this.smoothClick(this.page.getByRole('button', { name: '+ Adicionar produto', exact: true }));
      await this.fill(this.page.getByLabel('Nome do produto', { exact: true }).last(), name);
      await this.fill(this.page.getByLabel('Descrição', { exact: true }).last(), description);
    }
    await this.smoothClick(this.page.getByRole('button', { name: 'Salvar contexto', exact: true }));
    await this.page.getByText('Contexto salvo com sucesso.', { exact: true }).waitFor({ timeout: 20000 });
  }
  async importPreview() {
    if (this.state.completed['import-send']) {
      await this.pages.import?.bringToFront();
      return 'O lote já foi enviado nesta conta; não houve novo envio.';
    }
    await this.goto('/meetings/upload');
    this.pages.import = this.page;
    await this.smoothClick(this.page.getByRole('button', { name: 'JSON ou CSV', exact: true }));
    const picker = this.page.waitForEvent('filechooser', { timeout: 12000 });
    picker.catch(() => {});
    await this.smoothClick(this.page.getByRole('button', { name: 'Escolher arquivo', exact: true }));
    const chooser = await picker;
    this.check();
    await chooser.setFiles(this.config.batchFile);
    await this.page.getByRole('checkbox', { name: 'Selecionar todas (3)', exact: true }).waitFor();
    const all = this.page.getByRole('checkbox', { name: 'Selecionar todas (3)', exact: true });
    if (!await all.isChecked()) await this.smoothClick(all);
    await this.page.getByRole('button', { name: 'Importar 3 reuniões', exact: true }).waitFor();
    await this.smoothClick(this.page.locator('summary').filter({ hasText: 'Ver transcrição' }).first());
    return 'Três reuniões selecionadas. O próximo passo envia o lote.';
  }
  async importSend() {
    if (this.state.completed['import-send']) return 'Lote já enviado; nenhuma análise foi repetida.';
    if (this.state.importAttempted) throw new Error('Um envio já foi iniciado. Confira a lista de reuniões antes de continuar.');
    await this.pages.import?.bringToFront();
    const submit = this.page.getByRole('button', { name: 'Importar 3 reuniões', exact: true });
    await submit.waitFor({ state: 'visible', timeout: 5000 });
    this.state.importAttempted = true;
    await this.persist();
    await this.smoothClick(submit);
    await this.page.getByText(/análises concluídas/).first().waitFor({ timeout: 12000 });
    this.state.completed['import-send'] = new Date().toISOString();
    await this.persist();
    return 'Envio iniciado. O processamento continua nesta aba.';
  }
  async mainPage() {
    if (this.page === this.pages.import) {
      this.pages.detail ||= await this.context.newPage();
      this.page = this.pages.detail;
    }
    await this.page.bringToFront();
  }
  async meeting(titlePart) {
    await this.mainPage();
    await this.goto('/dashboard');
    const title = titlePart || 'Aster — proposta e limite financeiro';
    const link = this.page.getByRole('link', { name: title, exact: false }).first();
    await link.waitFor({ timeout: 20000 });
    await this.smoothClick(link);
    await this.page.locator('summary').filter({ hasText: 'Qualidade dos dados' }).waitFor({ timeout: 20000 });
    this.state.meetings[title] = new URL(this.page.url()).pathname.split('/').pop();
    await this.persist();
  }
  async quality() {
    const importPage = this.pages.import;
    if (importPage && !importPage.isClosed()) {
      await importPage.getByText('3 de 3 análises concluídas', { exact: false }).waitFor({ timeout: 180000 });
    }
    await this.meeting();
    const panel = this.page.locator('details').filter({ has: this.page.locator('summary').filter({ hasText: 'Qualidade dos dados' }) }).first();
    if (!await panel.evaluate((element) => element.open)) await this.smoothClick(panel.locator('summary'));
    await this.scrollTo(panel);
    await this.page.getByRole('heading', { name: 'Texto recebido', exact: true }).waitFor();
    return 'Qualidade e fontes da primeira reunião abertas.';
  }
  async evidence() {
    if (!/^\/meetings\/[a-f0-9-]+$/.test(new URL(this.page.url()).pathname)) await this.meeting();
    const products = this.page.locator('section[aria-label="Produtos"]');
    const values = this.page.locator('section[aria-label="Valores"]');
    const target = products.locator('summary').first();
    if (!await target.locator('..').evaluate((element) => element.open)) await this.smoothClick(target);
    const amount = values.locator('summary').first();
    if (!await amount.locator('..').evaluate((element) => element.open)) await this.smoothClick(amount);
    await this.scrollTo(products);
    return 'Fala de origem aberta. Confira produto e contexto do valor.';
  }
  async history() {
    await this.meeting();
    const history = this.page.getByText('Histórico do cliente', { exact: true });
    await this.scrollTo(history);
    await this.smoothClick(this.page.getByRole('link', { name: 'Aster — revisão e entrega confirmada', exact: true }));
    await this.page.locator('summary').filter({ hasText: 'Qualidade dos dados' }).waitFor();
    await this.scrollTo(this.page.getByText('Histórico do cliente', { exact: true }));
    await this.smoothClick(this.page.getByRole('link', { name: 'Aster — orçamento aprovado e condições do piloto', exact: true }));
    await this.page.locator('summary').filter({ hasText: 'Qualidade dos dados' }).waitFor();
    return 'Comitê mais recente aberto: orçamento aprovado, piloto condicionado.';
  }
  async taskRow() {
    await this.meeting();
    const track = this.page.getByRole('link', { name: 'Acompanhar', exact: true }).first();
    if (!/revis.*proposta|proposta.*revis/i.test(await track.locator('..').locator('..').innerText())) throw new Error('A primeira tarefa não é a revisão financeira esperada.');
    const href = await track.getAttribute('href');
    if (!href || !href.includes('#task-')) throw new Error('Não foi possível localizar a tarefa de revisão financeira.');
    this.state.taskUrl = href;
    this.state.taskId = href.split('#task-')[1];
    await this.persist();
    await this.smoothClick(track);
    const row = this.page.locator('[id="task-' + this.state.taskId + '"]');
    await row.waitFor();
    return row;
  }
  async taskEdit() {
    const row = await this.taskRow();
    const source = row.locator('summary').filter({ hasText: 'Fala de origem' });
    if (await source.count() && !await source.locator('..').evaluate((element) => element.open)) await this.smoothClick(source);
    await this.smoothClick(row.getByRole('button', { name: 'Editar', exact: true }));
    await this.fill(row.getByRole('textbox', { name: 'Responsável', exact: true }), 'Diretoria financeira');
    await this.smoothClick(row.getByRole('button', { name: 'Salvar', exact: true }));
    await row.getByRole('button', { name: 'Editar', exact: true }).waitFor();
    const due = row.locator('input[type="date"]');
    await this.fill(due, '2026-10-17');
    await this.page.waitForFunction((id) => !document.querySelector('[id="task-' + id + '"] input[type="date"]')?.disabled, this.state.taskId);
    await this.scrollTo(row);
    return 'Responsável e prazo atualizados para Diretoria financeira, 17/10.';
  }
  async taskDone() {
    if (!this.state.taskUrl) throw new Error('Execute a etapa de edição da tarefa primeiro.');
    await this.goto(this.state.taskUrl);
    let row = this.page.locator('[id="task-' + this.state.taskId + '"]');
    const checkbox = row.getByRole('checkbox');
    await checkbox.waitFor();
    if (!await checkbox.isChecked()) await this.smoothClick(checkbox);
    await this.page.waitForFunction((id) => document.querySelector('[id="task-' + id + '"] select')?.value === 'DONE' && !document.querySelector('[id="task-' + id + '"] select')?.disabled, this.state.taskId);
    this.check();
    await this.page.reload({ waitUntil: 'domcontentloaded' });
    row = this.page.locator('[id="task-' + this.state.taskId + '"]');
    await row.getByRole('combobox', { name: 'Alterar status', exact: true }).waitFor();
    if (await row.getByRole('combobox', { name: 'Alterar status', exact: true }).inputValue() !== 'DONE' || await row.locator('input[type="date"]').inputValue() !== '2026-10-17') throw new Error('A tarefa não persistiu como esperado.');
    await this.scrollTo(row);
    this.state.completed['task-done'] = new Date().toISOString();
    await this.persist();
    return 'Tarefa concluída; estado e prazo conferidos após recarregar.';
  }
  async chatAsk() {
    if (this.state.chatAttempted) {
      if (this.state.chatUrl) await this.goto(this.state.chatUrl);
      return 'Pergunta já enviada nesta conta. Exibindo a conversa existente.';
    }
    await this.mainPage();
    await this.goto('/chat');
    await this.fill(this.page.getByRole('textbox', { name: 'Pergunte qualquer coisa para a Nora', exact: true }), QUESTION);
    this.state.chatAttempted = true;
    await this.persist();
    await this.smoothClick(this.page.getByRole('button', { name: 'Enviar', exact: true }));
    await this.page.locator('[aria-label="Conversa com a Nora"][aria-busy="true"]').waitFor({ timeout: 15000 });
    await this.page.locator('[aria-label="Conversa com a Nora"][aria-busy="false"]').waitFor({ timeout: 120000 });
    this.check();
    this.state.chatUrl = new URL(this.page.url()).pathname + new URL(this.page.url()).search;
    this.state.completed['chat-ask'] = new Date().toISOString();
    await this.persist();
    return 'Resposta concluída. Confira os fatos atuais e as três fontes.';
  }
  async chatSources() {
    if (!this.state.chatUrl) throw new Error('Envie a pergunta antes de abrir as fontes.');
    await this.goto(this.state.chatUrl);
    const conversation = this.page.getByRole('log', { name: 'Conversa com a Nora' });
    const parent = await conversation.count() ? conversation : this.page.locator('[aria-label="Conversa com a Nora"]');
    const sources = parent.locator('a[href*="/meetings/"]');
    await sources.first().waitFor({ timeout: 15000 });
    const urls = await sources.evaluateAll((links) => [...new Set(links.map((link) => link.getAttribute('href')))]);
    if (urls.length < 3) throw new Error('A resposta não exibiu as três fontes esperadas. Confira antes de apresentar.');
    await this.scrollTo(sources.first());
    await this.smoothClick(sources.first());
    await this.page.waitForURL(/\/meetings\/[a-f0-9-]+$/, { timeout: 15000 });
    await this.page.locator('h1').waitFor({ state: 'visible', timeout: 15000 });
    return 'Referência aberta a partir do chat.';
  }
  async execute(stepId) {
    if (!ALLOWED_STEPS.has(stepId)) throw new Error('Etapa fora do roteiro.');
    this.check();
    const actions = {
      opening: async () => { await this.goto('/meetings/upload'); return 'Pronto para apresentar o problema e importar as transcrições.'; },
      'import-preview': () => this.importPreview(), 'import-send': () => this.importSend(),
      quality: () => this.quality(), evidence: () => this.evidence(), history: () => this.history(),
      'task-edit': () => this.taskEdit(), 'task-done': () => this.taskDone(),
      'chat-ask': () => this.chatAsk(), 'chat-sources': () => this.chatSources(),
      executive: async () => { await this.mainPage(); await this.goto('/enterprise'); return 'Visão executiva aberta.'; },
      closing: async () => { await this.mainPage(); await this.goto('/enterprise'); return 'Concluído. Apresente os limites e encerre.'; },
    };
    const controller = new AbortController();
    this.activeAbort = controller;
    const operation = this.scope.run(controller.signal, actions[stepId]);
    let listener;
    const interrupted = new Promise((_, reject) => {
      listener = () => reject(new Stopped());
      controller.signal.addEventListener('abort', listener, { once: true });
    });
    try { return await Promise.race([operation, interrupted]); }
    finally { controller.signal.removeEventListener('abort', listener); }
  }
  async heartbeat() {
    if (this.heartbeatPending) return;
    this.heartbeatPending = true;
    try {
      const native = await this.native.call('state');
      const stopFile = path.join(path.dirname(this.stateFile), 'stop.request');
      if (await fs.stat(stopFile).then(() => true, () => false)) {
        await fs.unlink(stopFile).catch(() => {});
        this.exiting = true;
        this.stopRequested = true;
        this.activeAbort?.abort();
      }
      if (native.stopped && this.active) { this.stopRequested = true; this.activeAbort?.abort(); }
      const result = await this.call('heartbeat', { commandId: this.active?.id });
      if (result.stopRequested && this.active) { this.stopRequested = true; this.activeAbort?.abort(); }
      this.networkFailures = 0;
    } catch {
      this.networkFailures++;
      if (this.active) { this.stopRequested = true; this.activeAbort?.abort(); }
    } finally { this.heartbeatPending = false; }
  }
  async run() {
    await this.initialize();
    this.timer = setInterval(() => void this.heartbeat(), 700);
    await this.heartbeat();
    while (!this.exiting) {
      let polled;
      try { polled = await this.call('poll', {}); } catch { await sleep(1500); continue; }
      if (!polled.command) { await sleep(700); continue; }
      const command = polled.command;
      if (command.type !== 'run' || !ALLOWED_STEPS.has(command.stepId)) {
        await this.result(command.id, 'failed', 'Comando fora do roteiro.');
        continue;
      }
      this.active = command;
      this.speed = [0.5, 1, 1.5, 2].includes(command.speed) ? command.speed : 1;
      this.stopRequested = !!polled.stopRequested;
      try {
        await this.result(command.id, 'running', 'Executando a etapa. F8 interrompe.');
        const message = await this.execute(command.stepId);
        this.check();
        await this.result(command.id, 'completed', message);
        console.log('COMPLETED ' + command.stepId + ' speed=' + this.speed);
      } catch (error) {
        const stopped = error instanceof Stopped || this.stopRequested || /Stopped with F8/.test(error.message);
        const message = stopped ? new Stopped().message : visibleError(error);
        await this.result(command.id, stopped ? 'stopped' : 'failed', message).catch(() => {});
        console.log((stopped ? 'STOPPED ' : 'FAILED ') + command.stepId + ': ' + String(error.message).slice(0, 1200));
      } finally { this.active = null; this.stopRequested = false; }
      await sleep(300);
    }
  }
  async close() {
    this.exiting = true;
    this.stopRequested = true;
    clearInterval(this.timer);
    this.native.close();
    await this.context?.close().catch(() => {});
  }
}

async function main() {
  const configPath = process.argv[2];
  if (!configPath) throw new Error('Provide the private agent configuration path.');
  const config = JSON.parse(await fs.readFile(configPath, 'utf8'));
  if (config.controlUrl !== 'https://nora.systems/presentation-control' && !config.controlUrl.startsWith('http://127.0.0.1:')) throw new Error('Unexpected control service.');
  const accountFile = JSON.parse(await fs.readFile(config.accountFile, 'utf8'));
  const account = accountFile.accounts?.director || accountFile;
  const runner = new PresentationRunner(config, account);
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => void runner.close().finally(() => process.exit(0)));
  try { await runner.run(); }
  catch (error) {
    if (runner.page) {
      await runner.page.screenshot({ path: path.join(path.dirname(config.stateFile), 'agent-error.png') }).catch(() => {});
      console.error('STARTUP PAGE ' + runner.page.url());
      console.error((await runner.page.locator('body').innerText().catch(() => '')).slice(0, 900));
    }
    throw error;
  } finally { await runner.close(); }
}

if (require.main === module) main().catch((error) => { console.error(String(error.message).slice(0, 350)); process.exitCode = 1; });
module.exports = { ALLOWED_STEPS, QUESTION, NativeMouse, PresentationRunner };
