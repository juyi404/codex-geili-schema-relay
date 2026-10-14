import { readFileSync } from 'node:fs';
import { normalizeGeminiTools, PORT } from './relay.mjs';

const home = (process.env.CODEX_HOME ?? `${process.env.USERPROFILE ?? process.env.HOME}/.codex`).replaceAll('\\', '/');
const config = readFileSync(`${home}/config.toml`, 'utf8');
const provider = /^\[model_providers\.custom\]\s*\r?\n([\s\S]*?)(?=^\[|$(?![\s\S]))/m.exec(config)?.[1];
const token = /^experimental_bearer_token\s*=\s*"([^"\r\n]+)"/m.exec(provider ?? '')?.[1];
if (!token) throw new Error('Configured provider token was not found; no credentials are printed.');
const payload = { model: 'gemini-4-argon', input: [{ role: 'user', content: 'Call schema_probe exactly once with ok=true. No other action.' }],
  tools: [{ type: 'function', name: 'schema_probe', description: 'Confirm boolean tool arguments.', parameters: {
    type: 'object', properties: { ok: { type: 'boolean', enum: [true] } }, required: ['ok'], additionalProperties: false,
  } }], tool_choice: { type: 'function', name: 'schema_probe' }, stream: false, max_output_tokens: 1024 };
if (process.argv.includes('--normalize-direct')) normalizeGeminiTools(payload);
const endpoint = process.argv.includes('--relay') ? `http://127.0.0.1:${PORT}/v1/responses` : 'https://sub.geiliapi.com/v1/responses';
const response = await fetch(endpoint, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
  body: JSON.stringify(payload), signal: AbortSignal.timeout(45000) });
const text = await response.text();
let body; try { body = JSON.parse(text); } catch { body = {}; }
const call = body.output?.find(item => item.type === 'function_call' && item.name === 'schema_probe');
let args; try { args = JSON.parse(call?.arguments ?? '{}'); } catch { args = {}; }
const ready = response.ok && args.ok === true;
const detail = !ready ? String(body.error?.message ?? text).replaceAll(token, '[REDACTED]').slice(0, 1200) : undefined;
console.log(JSON.stringify({ mode: process.argv.includes('--relay') ? 'relay' : process.argv.includes('--normalize-direct') ? 'normalized-direct' : 'original-direct',
  status: response.status, toolCalled: Boolean(call), booleanPreserved: typeof args.ok === 'boolean', ready, ...(detail ? { detail } : {}) }));
if (!ready) process.exitCode = 1;
