'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { AsyncLocalStorage } = require('node:async_hooks');
const { ALLOWED_STEPS, PresentationRunner } = require('./windows-agent.cjs');

test('only the fixed presentation steps can execute', async () => {
  assert.equal(ALLOWED_STEPS.size, 12);
  const runner = Object.create(PresentationRunner.prototype);
  runner.scope = new AsyncLocalStorage();
  await assert.rejects(runner.execute('arbitrary-shell'), /fora do roteiro/);
});

test('stopping a wait prevents its delayed continuation from clicking later', async () => {
  const runner = Object.create(PresentationRunner.prototype);
  runner.scope = new AsyncLocalStorage();
  runner.stopRequested = false;
  let release;
  const deferred = new Promise((resolve) => { release = resolve; });
  let clicks = 0;
  runner.quality = async () => { await deferred; runner.check(); clicks++; };
  const operation = runner.execute('quality');
  runner.activeAbort.abort();
  await assert.rejects(operation, /Interrompido/);
  runner.stopRequested = false;
  release();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(clicks, 0);
});

test('a fresh command can run after an interrupted command without reviving it', async () => {
  const runner = Object.create(PresentationRunner.prototype);
  runner.scope = new AsyncLocalStorage();
  let release;
  let staleActions = 0;
  runner.quality = async () => { await new Promise((resolve) => { release = resolve; }); runner.check(); staleActions++; };
  runner.evidence = async () => 'ready';
  const old = runner.execute('quality');
  runner.activeAbort.abort();
  await assert.rejects(old, /Interrompido/);
  assert.equal(await runner.execute('evidence'), 'ready');
  release();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(staleActions, 0);
});

test('evidence resumed from the upload page opens a meeting before reading evidence', async () => {
  const runner = Object.create(PresentationRunner.prototype);
  const meetingOpened = new Error('meeting navigation reached');
  let meetingCalls = 0;
  runner.page = {
    url: () => 'https://nora.systems/meetings/upload',
    locator: () => assert.fail('Evidence cannot be read from the upload page'),
  };
  runner.meeting = async () => { meetingCalls++; throw meetingOpened; };

  await assert.rejects(runner.evidence(), (error) => error === meetingOpened);
  assert.equal(meetingCalls, 1);
});

test('read-only navigation retries a closed or reset connection once before checking the page', async () => {
  for (const code of ['CLOSED', 'RESET']) {
    const runner = Object.create(PresentationRunner.prototype);
    runner.scope = new AsyncLocalStorage();
    const navigations = [];
    let readyChecks = 0;
    runner.page = {
      bringToFront: async () => {},
      url: () => 'https://nora.systems/meetings/upload',
      goto: async (url) => {
        navigations.push(url);
        if (navigations.length === 1) throw new Error(`page.goto: net::ERR_CONNECTION_${code}`);
      },
      locator: () => ({ first: () => ({ waitFor: async () => { readyChecks++; } }) }),
    };

    await runner.goto('/enterprise');
    assert.deepEqual(navigations, ['https://nora.systems/enterprise', 'https://nora.systems/enterprise']);
    assert.equal(readyChecks, 1);
  }
});

test('aborting during the navigation retry delay prevents a second request', async () => {
  const runner = Object.create(PresentationRunner.prototype);
  runner.scope = new AsyncLocalStorage();
  const controller = new AbortController();
  let navigations = 0;
  runner.page = {
    bringToFront: async () => {},
    url: () => 'https://nora.systems/meetings/upload',
    goto: async () => { navigations++; throw new Error('page.goto: net::ERR_CONNECTION_CLOSED'); },
    locator: () => assert.fail('An aborted navigation must not inspect the page'),
  };

  const operation = runner.scope.run(controller.signal, () => runner.goto('/enterprise'));
  const timer = setTimeout(() => controller.abort(), 20);
  try { await assert.rejects(operation, /Interrompido/); }
  finally { clearTimeout(timer); }
  assert.equal(navigations, 1);
});
