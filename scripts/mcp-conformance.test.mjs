import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { createServer } from 'node:http'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

const TOKEN = 'nora_mcp_private_test_credential/+=='
const PRIVATE = 'CONFIDENTIAL_MEETING_CONTENT'
const VERSIONS = ['2025-11-25', '2025-06-18']
const TOOLS = ['list_meetings', 'get_meeting', 'search_meetings', 'list_tasks', 'get_customer_confidence']
const script = fileURLToPath(new URL('./mcp-conformance.mjs', import.meta.url))

async function run(mode) {
  const sensitive = `${TOKEN} ${encodeURIComponent(TOKEN)} ${Buffer.from(TOKEN).toString('base64')} ${PRIVATE}`
  const server = createServer(async (req, res) => {
    const reply = (body, status = 200) => {
      res.writeHead(status, { 'content-type': 'application/json' })
      res.end(JSON.stringify(body))
    }
    if (req.url === '/meetings') return reply({}, 401)
    if (req.headers.authorization !== `Bearer ${TOKEN}`) return reply({ error: { message: sensitive } }, 401)
    let raw = ''
    for await (const chunk of req) raw += chunk
    const { method, params, id } = JSON.parse(raw)
    const success = (result) => reply({ jsonrpc: '2.0', id, result })
    const error = (code, message) => reply({
      jsonrpc: '2.0', id, error: { code, message, data: mode === 'valid' ? VERSIONS : sensitive },
    })
    if (method === 'initialize') {
      if (!VERSIONS.includes(params.protocolVersion)) {
        return error(-32602, mode === 'valid' ? VERSIONS.join(',') : sensitive)
      }
      if (mode === 'errors') return error(sensitive, sensitive)
      return success({
        protocolVersion: mode === 'valid' ? params.protocolVersion : sensitive,
        serverInfo: { name: sensitive },
        capabilities: mode === 'valid' ? { tools: {} } : { secret: sensitive },
      })
    }
    if (method === 'tools/list') {
      return success({ tools: TOOLS.map((name) => ({ name, inputSchema: {}, description: 'A read tool' })) })
    }
    if (method === 'tools/call') {
      if (params.name !== 'list_meetings') return error(-32602, sensitive)
      if (mode === 'errors') return error(sensitive, sensitive)
      return success(mode === 'valid' ? { content: [{ type: 'text', text: sensitive }] } : { meeting: sensitive })
    }
    return error(mode === 'valid' ? -32601 : -32000, sensitive)
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const { port } = server.address()
  const child = spawn(process.execPath, [script], {
    env: { ...process.env, NORA_URL: `http://127.0.0.1:${port}`, NORA_MCP_TOKEN: TOKEN },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let output = ''
  child.stdout.on('data', (chunk) => { output += chunk })
  child.stderr.on('data', (chunk) => { output += chunk })
  try {
    const [code] = await once(child, 'close')
    return { code, output }
  } finally {
    server.closeAllConnections()
    await new Promise((resolve) => server.close(resolve))
  }
}

for (const mode of ['valid', 'shapes', 'errors']) {
  test(`MCP diagnostics protect credentials and meeting data (${mode})`, { timeout: 10000 }, async () => {
    const { code, output } = await run(mode)
    assert.equal(code, mode === 'valid' ? 0 : 1)
    assert.match(output, /\d+ passed, \d+ failed/)
    for (const secret of [TOKEN, encodeURIComponent(TOKEN), Buffer.from(TOKEN).toString('base64'), PRIVATE]) {
      assert.ok(!output.includes(secret), 'diagnostics must not include a private response field')
    }
  })
}
