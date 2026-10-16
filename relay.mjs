import { createServer, request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

export const SERVICE = 'codex-geili-schema-relay';
export const PORT = Number(process.env.RELAY_PORT ?? 18766);
export const UPSTREAM = process.env.RELAY_UPSTREAM ?? 'https://sub.geiliapi.com/v1';
const MAX_BODY = 128 * 1024 * 1024;
const HOP = ['host', 'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade'];
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const clip = (text, max) => text.length > max ? `${text.slice(0, max)}…` : text;

function resolvePointer(ref, root) {
  if (typeof ref !== 'string' || !ref.startsWith('#/')) return undefined;
  let node = root;
  for (const part of ref.slice(2).split('/')) {
    const key = part.replace(/~1/g, '/').replace(/~0/g, '~');
    if (!object(node) || !(key in node)) return undefined;
    node = node[key];
  }
  return object(node) ? node : undefined;
}

// Gemini function declarations accept only an OpenAPI-style subset of JSON Schema:
// every node needs an explicit type, refs/combinators/conditionals are rejected or
// dropped upstream, enums must be strings. Normalize to that subset; tool
// implementations still validate their real arguments.
function normalizeSchema(schema, root = schema, chain = new Set()) {
  if (!object(schema)) return 0;
  let changed = 0;
  if ('$ref' in schema) {
    const ref = schema.$ref;
    const resolved = chain.has(ref) ? undefined : resolvePointer(ref, root);
    delete schema.$ref;
    changed++;
    if (resolved) {
      const inlined = structuredClone(resolved);
      normalizeSchema(inlined, root, new Set([...chain, ref]));
      for (const [key, value] of Object.entries(inlined)) if (!(key in schema)) schema[key] = value;
    }
  }
  if (Array.isArray(schema.allOf)) {
    for (const member of schema.allOf) {
      if (!object(member)) continue;
      normalizeSchema(member, root, chain);
      for (const [key, value] of Object.entries(member)) {
        if (key === 'properties' && object(value)) schema.properties = { ...value, ...(object(schema.properties) ? schema.properties : {}) };
        else if (key === 'required' && Array.isArray(value)) schema.required = [...new Set([...(Array.isArray(schema.required) ? schema.required : []), ...value])];
        else if (key !== 'allOf' && !(key in schema)) schema[key] = value;
      }
    }
    delete schema.allOf;
    changed++;
  }
  if (Array.isArray(schema.oneOf)) {
    schema.anyOf = [...(Array.isArray(schema.anyOf) ? schema.anyOf : []), ...schema.oneOf];
    delete schema.oneOf;
    changed++;
  }
  // GeiliAPI's Gemini translation drops anyOf wholesale, leaving a typeless node
  // that Gemini rejects — flatten to the first non-null member plus nullable.
  if (Array.isArray(schema.anyOf)) {
    const members = schema.anyOf.filter(object);
    if (members.some(member => member.type === 'null')) schema.nullable = true;
    const kept = members.filter(member => member.type !== 'null');
    for (const member of kept) changed += normalizeSchema(member, root, chain);
    const [first, ...rest] = kept;
    if (first) for (const [key, value] of Object.entries(first)) {
      // A branch's required list must not become unconditional, and its
      // properties must merge rather than be dropped when the parent has own ones.
      if (key === 'anyOf' || key === 'required') continue;
      if (key === 'properties' && object(value)) schema.properties = { ...value, ...(object(schema.properties) ? schema.properties : {}) };
      else if (!(key in schema)) schema[key] = value;
    }
    if (rest.length) {
      const alternatives = `Alternative accepted forms: ${clip(rest.map(member => JSON.stringify(member)).join(' | '), 400)}.`;
      schema.description = [schema.description, alternatives].filter(Boolean).join(' ');
    }
    delete schema.anyOf;
    changed++;
  }
  if (Array.isArray(schema.type)) {
    if (schema.type.includes('null')) schema.nullable = true;
    schema.type = schema.type.find(entry => entry !== 'null');
    changed++;
  }
  const values = Array.isArray(schema.enum) ? schema.enum : 'const' in schema ? [schema.const] : undefined;
  if (values?.length && values.some(value => typeof value !== 'string')) {
    if (schema.type === undefined) {
      if (values.every(value => typeof value === 'boolean')) schema.type = 'boolean';
      else if (values.every(value => typeof value === 'number')) schema.type = 'number';
    }
    const constraint = `Allowed values: ${clip(values.map(value => JSON.stringify(value)).join(', '), 600)}.`;
    schema.description = [schema.description, constraint].filter(Boolean).join(' ');
    delete schema.enum;
    delete schema.const;
    changed++;
  }
  if (typeof schema.const === 'string') {
    schema.enum = [schema.const];
    delete schema.const;
    changed++;
  }
  if (Array.isArray(schema.prefixItems)) {
    if (schema.items === undefined && object(schema.prefixItems[0])) schema.items = schema.prefixItems[0];
    delete schema.prefixItems;
    changed++;
  }
  for (const [exclusive, inclusive] of [['exclusiveMinimum', 'minimum'], ['exclusiveMaximum', 'maximum']]) {
    if (exclusive in schema) {
      if (typeof schema[exclusive] === 'number' && schema[inclusive] === undefined) schema[inclusive] = schema[exclusive];
      delete schema[exclusive];
      changed++;
    }
  }
  for (const key of ['not', 'if', 'then', 'else', 'dependentSchemas', 'dependentRequired', 'patternProperties', 'unevaluatedProperties', 'unevaluatedItems', 'propertyNames', 'contains', 'minContains', 'maxContains', '$schema', '$id', '$comment', '$anchor', '$dynamicRef', '$dynamicAnchor']) {
    if (key in schema) { delete schema[key]; changed++; }
  }
  // Gemini rejects any schema node without an explicit type.
  if (schema.type === undefined) {
    schema.type = object(schema.properties) || object(schema.additionalProperties) || 'required' in schema ? 'object'
      : 'items' in schema ? 'array'
      : 'string';
    changed++;
  }
  // Gemini rejects schemas whose required list names properties that are not
  // declared ("requires unspecified property") — prune to the declared set.
  if (Array.isArray(schema.required)) {
    const known = object(schema.properties) ? schema.required.filter(name => name in schema.properties) : [];
    if (known.length !== schema.required.length) {
      if (known.length) schema.required = known; else delete schema.required;
      changed++;
    }
  }
  if (object(schema.properties)) for (const child of Object.values(schema.properties)) changed += normalizeSchema(child, root, chain);
  for (const key of ['items', 'additionalProperties']) {
    if (Array.isArray(schema[key])) for (const child of schema[key]) changed += normalizeSchema(child, root, chain);
    else changed += normalizeSchema(schema[key], root, chain);
  }
  return changed;
}

export function normalizeGeminiTools(payload) {
  if (!object(payload) || !/(?:^|\/)gemini[-/]/i.test(payload.model ?? '')) return 0;
  let changed = 0;
  function visit(tool) {
    if (!object(tool)) return;
    if (Array.isArray(tool.tools)) for (const nested of tool.tools) visit(nested);
    const declarations = tool.functionDeclarations ?? tool.function_declarations;
    const definitions = Array.isArray(declarations) ? declarations : [object(tool.function) ? tool.function : tool];
    for (const definition of definitions) {
      if (!object(definition)) continue;
      for (const key of ['parameters', 'parametersJsonSchema', 'parameters_json_schema', 'input_schema']) {
        const schema = definition[key];
        changed += normalizeSchema(schema);
        // Definitions are inlined above; the containers themselves are rejected.
        if (object(schema)) for (const defs of ['$defs', 'definitions']) {
          if (defs in schema) { delete schema[defs]; changed++; }
        }
      }
    }
  }
  if (Array.isArray(payload.tools)) for (const tool of payload.tools) visit(tool);
  return changed;
}

// Gemini rejects conversations whose last turn is the model's own ("Requests
// ending with a model turn are not supported") — Codex sends exactly that when
// resuming after a truncated response. Append a continue nudge so the request
// is accepted and the model picks up where it left off.
export function normalizeGeminiTurns(payload) {
  if (!object(payload) || !/(?:^|\/)gemini[-/]/i.test(payload.model ?? '')) return 0;
  if (Array.isArray(payload.messages) && payload.messages.length) {
    const last = payload.messages.at(-1);
    if (!object(last) || (last.role !== 'assistant' && last.role !== 'model') || last.tool_calls) return 0;
    payload.messages.push({ role: 'user', content: 'Continue from exactly where you left off.' });
    return 1;
  }
  if (!Array.isArray(payload.input) || !payload.input.length) return 0;
  const last = payload.input.at(-1);
  if (!object(last)) return 0;
  if (last.role !== 'assistant' && last.role !== 'model' && last.type !== 'reasoning') return 0;
  payload.input.push({ type: 'message', role: 'user',
    content: [{ type: 'input_text', text: 'Continue from exactly where you left off.' }] });
  return 1;
}

// Gemini has a hard per-response output ceiling (~64k tokens including hidden
// thinking) and Codex surfaces hitting it as a stream error. Steer the model
// away from monster single responses so it never gets near the ceiling.
// Codex carries its system prompt as leading developer items in `input`
// (there is no top-level `instructions` string), so inject there.
const OUTPUT_GUIDANCE = '<output_budget>Hard limit: one response is cut off near 60000 tokens including hidden thinking, and the cutoff surfaces to the user as an error. Never emit one huge response. Write files in chunks of at most ~250 lines, extending them across subsequent steps. Prefer many small steps over one large one.</output_budget>';
export function injectGeminiOutputGuidance(payload) {
  if (!object(payload) || !/(?:^|\/)gemini[-/]/i.test(payload.model ?? '')) return 0;
  if (typeof payload.instructions === 'string') {
    if (payload.instructions.includes('<output_budget>')) return 0;
    payload.instructions += `\n\n${OUTPUT_GUIDANCE}`;
    return 1;
  }
  if (Array.isArray(payload.messages)) {
    let index = 0;
    for (const item of payload.messages) {
      if (!object(item) || (item.role !== 'system' && item.role !== 'developer')) break;
      if (JSON.stringify(item.content ?? '').includes('<output_budget>')) return 0;
      index++;
    }
    payload.messages.splice(index, 0, { role: 'system', content: OUTPUT_GUIDANCE });
    return 1;
  }
  if (!Array.isArray(payload.input)) return 0;
  let index = 0;
  for (const item of payload.input) {
    if (!object(item)) break;
    const leading = item.role === 'developer' || item.role === 'system' || item.type === 'additional_tools';
    if (!leading) break;
    if (JSON.stringify(item.content ?? '').includes('<output_budget>')) return 0;
    index++;
  }
  payload.input.splice(index, 0, { type: 'message', role: 'developer',
    content: [{ type: 'input_text', text: OUTPUT_GUIDANCE }] });
  return 1;
}

// Codex never sends max_output_tokens; some gateways then apply a small default
// of their own and long responses come back truncated (incomplete:
// max_output_tokens). Pin the field to Gemini's real per-response maximum.
export function injectGeminiMaxOutput(payload) {
  if (!object(payload) || !/(?:^|\/)gemini[-/]/i.test(payload.model ?? '')) return 0;
  if (Array.isArray(payload.messages)) {
    if (payload.max_tokens != null || payload.max_completion_tokens != null) return 0;
    payload.max_tokens = 65536;
    return 1;
  }
  if (payload.max_output_tokens != null) return 0;
  payload.max_output_tokens = 65536;
  return 1;
}

function headersWithoutHop(headers) {
  const result = { ...headers };
  for (const name of [...HOP, ...String(headers.connection ?? '').split(',').map(name => name.trim().toLowerCase())]) delete result[name];
  return result;
}

const STREAM_RETRYABLE = /Unknown name \\?"(?:anthropic_version|messages|system|max_tokens)\\?"|All available accounts exhausted|server_is_overloaded|service_unavailable/i;
const STREAM_CONTENT = /"type"\s*:\s*"response\.(?:output_item|content_part|output_text|reasoning|function_call|completed|incomplete)|"object"\s*:\s*"chat\.completion/;
// Gateways often return 200, open the SSE stream, and only then emit an error
// event for a failed upstream call. Nothing has reached the client yet at that
// point, so hold the stream back until the first real output event and retry
// transient early errors exactly like their 4xx counterparts.
function guardStream(response) {
  return new Promise(resolve => {
    const chunks = [];
    let size = 0;
    const finish = verdict => {
      response.pause();
      response.removeListener('data', onData);
      response.removeListener('end', onEnd);
      response.removeListener('error', onEnd);
      resolve({ verdict, preamble: Buffer.concat(chunks) });
    };
    const onEnd = () => finish('ended');
    const onData = chunk => {
      chunks.push(Buffer.from(chunk));
      size += chunk.length;
      const text = Buffer.concat(chunks).toString('utf8');
      if (STREAM_CONTENT.test(text) || size > 262144) finish('pipe');
      else if (STREAM_RETRYABLE.test(text)) finish('retry');
    };
    response.on('data', onData);
    response.once('end', onEnd);
    response.once('error', onEnd);
  });
}

export function createRelay({ upstream = UPSTREAM, log = () => {}, digest = 'test' } = {}) {
  const target = new URL(upstream);
  const controllers = new Set();
  let normalizedRequests = 0;
  let normalizedConstraints = 0;
  const server = createServer((req, res) => {
    const controller = new AbortController();
    controllers.add(controller);
    res.once('close', () => controller.abort());
    void (async () => {
      const requestUrl = new URL(req.url ?? '/', 'http://127.0.0.1');
      if (req.method === 'GET' && requestUrl.pathname === '/health') {
        res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
        res.end(JSON.stringify({ service: SERVICE, digest, normalizedRequests, normalizedConstraints }));
        return;
      }
      if (!['POST', 'GET'].includes(req.method) || !requestUrl.pathname.startsWith('/v1/')) { res.writeHead(404).end(); return; }
      if (req.headers.origin || !/^Bearer\s+\S+/i.test(req.headers.authorization ?? '')) { res.writeHead(403).end(); return; }
      if (Number(req.headers['content-length']) > MAX_BODY) { res.writeHead(413, { connection: 'close' }).end(); return; }
      const chunks = [];
      let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > MAX_BODY) { res.writeHead(413, { connection: 'close' }).end(); return; }
        chunks.push(Buffer.from(chunk));
      }
      let body = Buffer.concat(chunks);
      // All rewrites are gemini-only; skip the JSON round-trip entirely for
      // payloads that cannot name a gemini model (GPT traffic passes untouched).
      if (req.method === 'POST' && /\/(?:responses(?:\/(?:lite|compact))?|chat\/completions)$/.test(requestUrl.pathname) && body.includes('gemini')) {
        let payload;
        try { payload = JSON.parse(body.toString('utf8')); }
        catch { res.writeHead(400).end('Invalid JSON request'); return; }
        const count = normalizeGeminiTools(payload);
        const appended = normalizeGeminiTurns(payload);
        const guided = injectGeminiOutputGuidance(payload);
        const capped = injectGeminiMaxOutput(payload);
        if (count || appended || guided || capped) {
          body = Buffer.from(JSON.stringify(payload));
          normalizedRequests++;
          normalizedConstraints += count;
          log({ event: 'gemini_schema_normalized', count, max_output_tokens: payload.max_output_tokens ?? null,
            ...(capped ? { max_output_tokens_injected: true } : {}),
            ...(appended ? { appended_continue_turn: true } : {}), ...(guided ? { output_guidance: true } : {}) });
        }
      }
      const url = new URL(target);
      url.pathname = `${target.pathname.replace(/\/$/, '')}${requestUrl.pathname.slice(3)}`;
      url.search = requestUrl.search;
      const headers = headersWithoutHop(req.headers);
      headers['content-length'] = String(body.length);
      const sendUpstream = () => new Promise((resolve, reject) => {
        const outgoing = (url.protocol === 'https:' ? httpsRequest : httpRequest)(url, {
          method: req.method, headers, signal: controller.signal,
        }, resolve);
        outgoing.once('socket', socket => {
          // A late TLS write failure must not crash the persistent relay after teardown.
          if (!socket.listenerCount('error')) socket.on('error', () => {});
        });
        outgoing.once('error', reject);
        outgoing.end(body);
      });
      // The upstream's model pools occasionally route a request through a channel
      // speaking the wrong provider dialect (an Anthropic-format payload sent to a
      // Gemini backend), or briefly run out of pooled upstream accounts. Both are
      // per-attempt transients, so re-sending re-rolls them.
      const MISROUTE = /Unknown name \\?"(?:anthropic_version|messages|system|max_tokens)\\?"/;
      const EXHAUSTED = /All available accounts exhausted/i;
      let response;
      let errorBody;
      let guarded;
      for (let attempt = 0; ; attempt++) {
        // Nothing has been sent to the client before headers arrive, so transient
        // connection failures (reset, refused, DNS blip) are safe to retry here
        // instead of bouncing a full re-upload back to Codex.
        try {
          response = await sendUpstream();
        } catch (error) {
          if (controller.signal.aborted || attempt >= 2) throw error;
          log({ event: 'upstream_connect_retry', code: typeof error.code === 'string' ? error.code : 'UNKNOWN', attempt: attempt + 1 });
          await new Promise(resolve => setTimeout(resolve, 300 * (attempt + 1)));
          continue;
        }
        errorBody = undefined;
        guarded = undefined;
        const status = response.statusCode ?? 0;
        if (status < 300) {
          if (!/text\/event-stream/.test(String(response.headers['content-type'] ?? ''))) break;
          guarded = await guardStream(response);
          if (guarded.verdict !== 'retry' || attempt >= 4) break;
          response.destroy();
          log({ event: 'upstream_misroute_retry', status, attempt: attempt + 1, reason: 'sse_early_error' });
          await new Promise(resolve => setTimeout(resolve, 700 * (attempt + 1)));
          continue;
        }
        if (status < 400) break;
        const errorChunks = [];
        for await (const chunk of response) errorChunks.push(Buffer.from(chunk));
        errorBody = Buffer.concat(errorChunks);
        if (attempt >= 4) break;
        let text;
        try { text = response.headers['content-encoding'] === 'gzip' ? gunzipSync(errorBody).toString('utf8') : errorBody.toString('utf8'); }
        catch { text = errorBody.toString('utf8'); }
        const misroute = MISROUTE.test(text);
        if (!misroute && !EXHAUSTED.test(text)) break;
        log({ event: 'upstream_misroute_retry', status: response.statusCode, attempt: attempt + 1,
          reason: misroute ? 'dialect_misroute' : 'accounts_exhausted' });
        await new Promise(resolve => setTimeout(resolve, (misroute ? 300 : 1500) * (attempt + 1)));
      }
      if (response.statusCode >= 300 && response.statusCode < 400) {
        response.resume(); res.writeHead(502).end('Upstream redirects are disabled'); return;
      }
      if (errorBody !== undefined) {
        res.writeHead(response.statusCode ?? 502, headersWithoutHop(response.headers));
        res.end(errorBody);
        return;
      }
      if (guarded !== undefined) {
        res.writeHead(response.statusCode ?? 502, headersWithoutHop(response.headers));
        res.write(guarded.preamble);
        if (guarded.verdict === 'ended' || response.readableEnded || response.destroyed) { res.end(); return; }
        await new Promise((resolve, reject) => {
          response.once('error', reject);
          response.once('end', resolve);
          response.pipe(res);
        });
        return;
      }
      await new Promise((resolve, reject) => {
        res.writeHead(response.statusCode ?? 502, headersWithoutHop(response.headers));
        response.once('error', reject);
        response.once('end', resolve);
        response.pipe(res);
      });
    })().catch(error => {
      if (!controller.signal.aborted) log({ event: 'upstream_transport_error', code: typeof error.code === 'string' ? error.code : 'UNKNOWN' });
      if (!res.headersSent) res.writeHead(502).end('Codex model relay transport error');
      else res.destroy();
    }).finally(() => controllers.delete(controller));
  });
  const close = async () => {
    for (const controller of controllers) controller.abort();
    server.closeAllConnections();
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  };
  return { server, close };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const digest = createHash('sha256').update(readFileSync(fileURLToPath(import.meta.url))).digest('hex');
  const relay = createRelay({ digest, log: event => process.stdout.write(`${JSON.stringify({ time: new Date().toISOString(), ...event })}\n`) });
  relay.server.once('error', error => { process.stderr.write(`${error.code ?? 'LISTEN_FAILED'}\n`); process.exitCode = 1; });
  relay.server.listen(PORT, '127.0.0.1', () => process.stdout.write(`${SERVICE} listening on 127.0.0.1:${PORT}\n`));
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { void relay.close().then(() => process.exit()); });
}
