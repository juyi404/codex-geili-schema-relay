import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync, rmSync, readdirSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { once } from 'node:events';
import assert from 'node:assert/strict';

const root = (process.env.CODEX_HOME ?? `${process.env.USERPROFILE ?? process.env.HOME}/.codex`).replaceAll('\\', '/');
const temp = mkdtempSync(`${root}/compat/geili-schema-relay/verification-`);
const config = readFileSync(`${root}/config.toml`, 'utf8').split('[desktop]')[0];
writeFileSync(`${temp}/config.toml`, config);
const binRoot = `${(process.env.LOCALAPPDATA ?? '').replaceAll('\\', '/')}/OpenAI/Codex/bin`;
const exe = process.env.CODEX_EXE ?? `${binRoot}/${readdirSync(binRoot).at(-1)}/codex.exe`;
const child = spawn(exe, ['app-server', '--listen', 'stdio://'], { cwd: temp, env: { ...process.env, CODEX_HOME: temp },
  windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
const requests = new Map();
let id = 0;
let turnResult;
let finishTurn;
const turnErrors = [];
const lines = createInterface({ input: child.stdout });
const stderr = [];
child.stderr.on('data', chunk => stderr.push(String(chunk)));
lines.on('line', line => {
  let message; try { message = JSON.parse(line); } catch { return; }
  if (message.id !== undefined && requests.has(message.id)) {
    const pending = requests.get(message.id); requests.delete(message.id); clearTimeout(pending.timer);
    if (message.error) pending.reject(new Error(JSON.stringify(message.error)));
    else pending.resolve(message.result);
  }
  if (message.method === 'error') turnErrors.push(message.params?.error?.message ?? 'Codex turn error');
  if (message.method === 'turn/completed') {
    turnResult = message.params.turn;
    finishTurn?.(turnResult);
  }
});
const send = (method, params) => new Promise((resolve, reject) => {
  const requestId = ++id;
  const timer = setTimeout(() => { requests.delete(requestId); reject(new Error(`Timed out: ${method}`)); }, 25000);
  requests.set(requestId, { resolve, reject, timer });
  child.stdin.write(`${JSON.stringify({ id: requestId, method, params })}\n`);
});
try {
  await send('initialize', { clientInfo: { name: 'geili_schema_verification', version: '1.0' } });
  child.stdin.write(`${JSON.stringify({ method: 'initialized', params: {} })}\n`);
  const models = await send('model/list', { limit: 100, includeHidden: false });
  const expected = JSON.parse(readFileSync(`${root}/geili-model-catalog.json`, 'utf8')).models.map(model => model.slug).sort();
  assert.deepEqual(models.data.map(model => model.model).sort(), expected);
  const effective = await send('config/read', { includeLayers: false });
  assert.equal(effective.config.model_providers.custom.base_url, 'http://127.0.0.1:18766/v1');
  if (process.argv.includes('--turn')) {
    const thread = await send('thread/start', { cwd: temp, model: 'gemini-4-argon', modelProvider: 'custom',
      approvalPolicy: 'never', sandbox: 'read-only', ephemeral: true,
      baseInstructions: 'This is a protocol smoke test. Reply exactly OK. Do not call tools, read or modify files, or execute commands.' });
    await send('turn/start', { threadId: thread.thread.id, model: 'gemini-4-argon', effort: 'low',
      input: [{ type: 'text', text: 'Reply exactly OK.', text_elements: [] }] });
    const turn = turnResult ?? await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Codex smoke test timed out')), 180000);
      finishTurn = result => { clearTimeout(timer); resolve(result); };
    });
    assert.equal(turn.status, 'completed', JSON.stringify({ status: turn.status, error: turn.error, turnErrors }));
    console.log(JSON.stringify({ codexGeminiTurnCompleted: true, status: turn.status }));
  }
  console.log(JSON.stringify({ ready: true, modelCount: models.data.length, models: expected, default: effective.config.model, relayConfigured: true }));
} finally {
  for (const pending of requests.values()) clearTimeout(pending.timer);
  const closed = once(child, 'close');
  child.kill(); await closed;
  lines.close();
  rmSync(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
