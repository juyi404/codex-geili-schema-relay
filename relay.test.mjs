import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { normalizeGeminiTools, normalizeGeminiTurns, injectGeminiOutputGuidance, injectGeminiMaxOutput, createRelay, SERVICE } from './relay.mjs';

const parameters = () => ({ type: 'object', properties: {
  enabled: { type: 'boolean', enum: [true] },
  number: { type: 'integer', enum: [1, 2] },
  mode: { type: 'string', enum: ['read', 'write'] },
  enum: { type: 'array', items: { const: false } },
  nested: { anyOf: [{ type: 'object', additionalProperties: { type: 'boolean', enum: [false] } }] },
}, required: ['enabled'], additionalProperties: false });

test('keeps argument types and string enums while removing incompatible nested enum/const', () => {
  const schema = parameters();
  const payload = { model: 'gemini-4-argon', tools: [{ type: 'function', name: 'check', parameters: schema }],
    input: [{ role: 'user', content: { enum: [true], const: false } }] };
  const input = structuredClone(payload.input);
  assert.equal(normalizeGeminiTools(payload), 5);
  assert.equal(schema.properties.enabled.type, 'boolean');
  assert.equal(schema.properties.enabled.enum, undefined);
  assert.match(schema.properties.enabled.description, /Allowed values: true/);
  assert.equal(schema.properties.number.type, 'integer');
  assert.deepEqual(schema.properties.mode.enum, ['read', 'write']);
  assert.equal(schema.properties.enum.items.type, 'boolean');
  assert.equal(schema.properties.nested.anyOf, undefined);
  assert.equal(schema.properties.nested.type, 'object');
  assert.equal(schema.additionalProperties, false);
  assert.deepEqual(payload.input, input);
  assert.equal(normalizeGeminiTools(payload), 0);
});

test('adds missing type fields required by Gemini function declarations', () => {
  const schema = { type: 'object', properties: {
    sectionId: { description: 'Target section' },
    name: { enum: ['a', 'b'] },
    filter: { properties: { id: { type: 'string' } } },
    tags: { items: { type: 'string' } },
    choice: { anyOf: [{ type: 'string' }, { type: 'number' }] },
  } };
  const payload = { model: 'gemini-4-argon', tools: [{ type: 'function', name: 'move_project_to_sidebar_section', parameters: schema }] };
  assert.equal(normalizeGeminiTools(payload), 5);
  assert.equal(schema.properties.sectionId.type, 'string');
  assert.equal(schema.properties.name.type, 'string');
  assert.deepEqual(schema.properties.name.enum, ['a', 'b']);
  assert.equal(schema.properties.filter.type, 'object');
  assert.equal(schema.properties.tags.type, 'array');
  assert.equal(schema.properties.choice.anyOf, undefined);
  assert.equal(schema.properties.choice.type, 'string');
  assert.match(schema.properties.choice.description, /Alternative accepted forms/);
  assert.equal(normalizeGeminiTools(payload), 0);
});

test('flattens nullable anyOf params that GeiliAPI strips (sectionId regression)', () => {
  const schema = { type: 'object', properties: {
    sectionId: { anyOf: [{ type: 'string' }, { type: 'null' }], description: 'Target section id, or null to ungroup.' },
  }, additionalProperties: false };
  const payload = { model: 'gemini-4-argon', tools: [{ type: 'function', name: 'mcp__codex_app__move_project_to_sidebar_section', parameters: schema }] };
  assert.ok(normalizeGeminiTools(payload) > 0);
  assert.deepEqual(schema.properties.sectionId, { type: 'string', nullable: true, description: 'Target section id, or null to ungroup.' });
  assert.equal(normalizeGeminiTools(payload), 0);
});

test('resolves refs and rewrites combinators and draft keywords for Gemini', () => {
  const schema = { type: 'object', $defs: { section: { type: 'string', description: 'Section id' } }, properties: {
    sectionId: { $ref: '#/$defs/section' },
    target: { oneOf: [{ type: 'string' }, { type: 'number' }] },
    options: { allOf: [
      { type: 'object', properties: { a: { type: 'string' } }, required: ['a'] },
      { properties: { b: { type: 'number' } }, required: ['b'] },
    ] },
    maybe: { type: ['string', 'null'] },
    fixed: { const: 'pinned' },
    coords: { type: 'array', prefixItems: [{ type: 'number' }] },
    amount: { type: 'number', exclusiveMinimum: 0 },
    odd: { not: { type: 'string' } },
  } };
  const payload = { model: 'gemini-4-argon', tools: [{ type: 'function', name: 'probe', parameters: schema }] };
  assert.ok(normalizeGeminiTools(payload) > 0);
  assert.equal(schema.$defs, undefined);
  assert.deepEqual(schema.properties.sectionId, { type: 'string', description: 'Section id' });
  assert.equal(schema.properties.target.oneOf, undefined);
  assert.equal(schema.properties.target.anyOf, undefined);
  assert.equal(schema.properties.target.type, 'string');
  assert.match(schema.properties.target.description, /Alternative accepted forms/);
  assert.equal(schema.properties.options.allOf, undefined);
  assert.deepEqual(Object.keys(schema.properties.options.properties).sort(), ['a', 'b']);
  assert.deepEqual([...schema.properties.options.required].sort(), ['a', 'b']);
  assert.equal(schema.properties.maybe.type, 'string');
  assert.equal(schema.properties.maybe.nullable, true);
  assert.deepEqual(schema.properties.fixed.enum, ['pinned']);
  assert.equal(schema.properties.fixed.type, 'string');
  assert.deepEqual(schema.properties.coords.items, { type: 'number' });
  assert.equal(schema.properties.coords.prefixItems, undefined);
  assert.equal(schema.properties.amount.minimum, 0);
  assert.equal(schema.properties.amount.exclusiveMinimum, undefined);
  assert.equal(schema.properties.odd.not, undefined);
  assert.equal(schema.properties.odd.type, 'string');
  assert.equal(normalizeGeminiTools(payload), 0);
});

test('retries upstream provider-dialect misroutes; forwards other errors untouched', async () => {
  let hits = 0;
  let mode = 'misroute-twice';
  const upstream = createServer(async (req, res) => {
    for await (const chunk of req) void chunk;
    hits++;
    if (mode === 'misroute-twice' && hits < 3) {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'Invalid JSON payload received. Unknown name "anthropic_version": Cannot find field.' } }));
    } else if (mode === 'exhausted-once' && hits === 5) {
      res.writeHead(503, { 'content-type': 'application/json' });
      res.end('{"error":{"message":"All available accounts exhausted"}}');
    } else if (mode === 'balance') {
      res.writeHead(403, { 'content-type': 'application/json' });
      res.end('{"error":{"code":"INSUFFICIENT_BALANCE"}}');
    } else {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"ok":true}');
    }
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const relay = createRelay({ upstream: `http://127.0.0.1:${upstream.address().port}/v1` });
  await new Promise(resolve => relay.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${relay.server.address().port}`;
  const post = () => fetch(`${base}/v1/responses`, { method: 'POST', headers: { authorization: 'Bearer test-key' }, body: '{"model":"gpt-6-astra"}' });
  try {
    const recovered = await post();
    assert.equal(recovered.status, 200);
    assert.equal(await recovered.text(), '{"ok":true}');
    assert.equal(hits, 3);
    mode = 'balance';
    const denied = await post();
    assert.equal(denied.status, 403);
    assert.match(await denied.text(), /INSUFFICIENT_BALANCE/);
    assert.equal(hits, 4);
    mode = 'exhausted-once';
    const recoveredPool = await post();
    assert.equal(recoveredPool.status, 200);
    assert.equal(await recoveredPool.text(), '{"ok":true}');
    assert.equal(hits, 6);
  } finally {
    await relay.close(); upstream.closeAllConnections();
    await new Promise(resolve => upstream.close(resolve));
  }
});

test('appends a continue turn when gemini input ends with a model turn', () => {
  const trailingAssistant = { model: 'gemini-4-argon', input: [
    { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] },
    { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'partial' }] },
  ] };
  assert.equal(normalizeGeminiTurns(trailingAssistant), 1);
  assert.equal(trailingAssistant.input.length, 3);
  assert.equal(trailingAssistant.input.at(-1).role, 'user');
  assert.equal(normalizeGeminiTurns(trailingAssistant), 0);
  const trailingToolOutput = { model: 'gemini-4-argon', input: [
    { type: 'message', role: 'assistant', content: [] },
    { type: 'function_call_output', call_id: 'c1', output: 'ok' },
  ] };
  assert.equal(normalizeGeminiTurns(trailingToolOutput), 0);
  const gpt = { model: 'gpt-6-astra', input: [{ type: 'message', role: 'assistant', content: [] }] };
  assert.equal(normalizeGeminiTurns(gpt), 0);
});

test('injects output-budget guidance into gemini instructions only', () => {
  const gemini = { model: 'gemini-4-argon', instructions: 'You are Codex.' };
  assert.equal(injectGeminiOutputGuidance(gemini), 1);
  assert.match(gemini.instructions, /^You are Codex\.[\s\S]*<output_budget>/);
  assert.equal(injectGeminiOutputGuidance(gemini), 0);
  assert.equal(gemini.instructions.split('<output_budget>').length, 2);
  const codexShaped = { model: 'gemini-4-argon', input: [
    { type: 'additional_tools', role: 'developer', content: [] },
    { type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'base instructions' }] },
    { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] },
  ] };
  assert.equal(injectGeminiOutputGuidance(codexShaped), 1);
  assert.equal(codexShaped.input.length, 4);
  assert.equal(codexShaped.input[2].role, 'developer');
  assert.match(codexShaped.input[2].content[0].text, /<output_budget>/);
  assert.equal(codexShaped.input[3].role, 'user');
  assert.equal(injectGeminiOutputGuidance(codexShaped), 0);
  const gpt = { model: 'gpt-6.1-sol', instructions: 'You are Codex.' };
  assert.equal(injectGeminiOutputGuidance(gpt), 0);
  assert.equal(gpt.instructions, 'You are Codex.');
  assert.equal(injectGeminiOutputGuidance({ model: 'gemini-4-argon' }), 0);
});

test('retries transient connection failures before any response bytes', async () => {
  let connections = 0;
  const upstream = createServer(async (req, res) => {
    for await (const chunk of req) void chunk;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"ok":true}');
  });
  upstream.on('connection', socket => { if (++connections <= 2) socket.destroy(); });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const relay = createRelay({ upstream: `http://127.0.0.1:${upstream.address().port}/v1` });
  await new Promise(resolve => relay.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${relay.server.address().port}`;
  try {
    const response = await fetch(`${base}/v1/responses`, { method: 'POST',
      headers: { authorization: 'Bearer test-key' }, body: '{"model":"gpt-6-astra"}' });
    assert.equal(response.status, 200);
    assert.equal(await response.text(), '{"ok":true}');
    assert.equal(connections, 3);
  } finally {
    await relay.close(); upstream.closeAllConnections();
    await new Promise(resolve => upstream.close(resolve));
  }
});

test('pins max_output_tokens for gemini requests that lack one', () => {
  const bare = { model: 'gemini-4-argon' };
  assert.equal(injectGeminiMaxOutput(bare), 1);
  assert.equal(bare.max_output_tokens, 65536);
  assert.equal(injectGeminiMaxOutput(bare), 0);
  const explicit = { model: 'gemini-4-argon', max_output_tokens: 64 };
  assert.equal(injectGeminiMaxOutput(explicit), 0);
  assert.equal(explicit.max_output_tokens, 64);
  const gpt = { model: 'gpt-6.1-sol' };
  assert.equal(injectGeminiMaxOutput(gpt), 0);
  assert.equal(gpt.max_output_tokens, undefined);
});

test('retries SSE streams that error before any output; forwards fatal ones', async () => {
  let hits = 0;
  let mode = 'misroute-then-ok';
  const upstream = createServer(async (req, res) => {
    for await (const chunk of req) void chunk;
    hits++;
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    if (mode === 'misroute-then-ok' && hits === 1) {
      res.write('event: error\n');
      res.end('data: {"type":"error","error":{"message":"Invalid JSON payload received. Unknown name \\"anthropic_version\\": Cannot find field."}}\n\n');
    } else if (mode === 'fatal') {
      res.write('event: error\n');
      res.end('data: {"type":"error","error":{"message":"quota exceeded for this key"}}\n\n');
    } else {
      res.write('data: {"type":"response.output_text.delta","delta":"OK"}\n\n');
      res.end('data: {"type":"response.completed"}\n\n');
    }
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const relay = createRelay({ upstream: `http://127.0.0.1:${upstream.address().port}/v1` });
  await new Promise(resolve => relay.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${relay.server.address().port}`;
  const post = () => fetch(`${base}/v1/responses`, { method: 'POST',
    headers: { authorization: 'Bearer test-key' }, body: '{"model":"gpt-6-astra","stream":true}' });
  try {
    const recovered = await post();
    const text = await recovered.text();
    assert.equal(recovered.status, 200);
    assert.match(text, /response\.completed/);
    assert.doesNotMatch(text, /anthropic_version/);
    assert.equal(hits, 2);
    mode = 'fatal';
    const fatal = await post();
    assert.equal(fatal.status, 200);
    assert.match(await fatal.text(), /quota exceeded/);
    assert.equal(hits, 3);
  } finally {
    await relay.close(); upstream.closeAllConnections();
    await new Promise(resolve => upstream.close(resolve));
  }
});

test('merges anyOf branch properties and prunes required to declared properties', () => {
  const schema = { type: 'object', properties: { keep: { type: 'string' } }, anyOf: [
    { type: 'object', properties: { mode: { type: 'string' } }, required: ['mode', 'ghost'] },
    { type: 'null' },
  ] };
  const payload = { model: 'gemini-4-argon', tools: [{ type: 'function', name: 'probe', parameters: schema }] };
  assert.ok(normalizeGeminiTools(payload) > 0);
  assert.deepEqual(Object.keys(schema.properties).sort(), ['keep', 'mode']);
  assert.equal(schema.required, undefined);
  assert.equal(schema.nullable, true);
  const pruned = { type: 'object', properties: { a: { type: 'string' } }, required: ['a', 'mode'] };
  assert.ok(normalizeGeminiTools({ model: 'gemini-4-argon', tools: [{ type: 'function', name: 'p2', parameters: pruned }] }) > 0);
  assert.deepEqual(pruned.required, ['a']);
  const orphan = { type: 'object', required: ['mode'] };
  normalizeGeminiTools({ model: 'gemini-4-argon', tools: [{ type: 'function', name: 'p3', parameters: orphan }] });
  assert.equal(orphan.required, undefined);
});

test('normalizes namespace tools and provider declaration formats', () => {
  for (const tool of [
    { type: 'namespace', tools: [{ type: 'function', parameters: parameters() }] },
    { type: 'function', function: { parameters: parameters() } },
    { function_declarations: [{ parameters_json_schema: parameters() }] },
    { functionDeclarations: [{ parametersJsonSchema: parameters() }] },
  ]) assert.equal(normalizeGeminiTools({ model: 'google/gemini-4-argon', tools: [tool] }), 5);
});

test('does not modify GPT or Claude schemas', () => {
  for (const model of ['gpt-6-astra', 'gpt-5.6-sol', 'claude-opus-5.5']) {
    const payload = { model, tools: [{ parameters: parameters() }] };
    const before = JSON.stringify(payload);
    assert.equal(normalizeGeminiTools(payload), 0);
    assert.equal(JSON.stringify(payload), before);
  }
});

test('forwards authorization and SSE; fixes Gemini only; rejects unauthenticated requests', async () => {
  const captured = [];
  const upstream = createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    captured.push({ url: req.url, auth: req.headers.authorization, body: Buffer.concat(chunks).toString() });
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('data: {"ok":true}\n\n'); res.end('data: [DONE]\n\n');
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const relay = createRelay({ upstream: `http://127.0.0.1:${upstream.address().port}/v1` });
  await new Promise(resolve => relay.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${relay.server.address().port}`;
  try {
    assert.equal((await (await fetch(`${base}/health`)).json()).service, SERVICE);
    assert.equal((await fetch(`${base}/v1/responses`, { method: 'POST', body: '{}' })).status, 403);
    for (const model of ['gemini-4-argon', 'gpt-6-astra']) {
      const body = JSON.stringify({ model, tools: [{ type: 'function', name: 'probe', parameters: parameters() }] }, null, 2);
      const response = await fetch(`${base}/v1/responses?test=1`, { method: 'POST', headers: { authorization: 'Bearer test-key' }, body });
      assert.equal(await response.text(), 'data: {"ok":true}\n\ndata: [DONE]\n\n');
      const sent = captured.at(-1);
      assert.equal(sent.auth, 'Bearer test-key');
      assert.equal(sent.url, '/v1/responses?test=1');
      if (model.startsWith('gemini')) assert.equal(JSON.parse(sent.body).tools[0].parameters.properties.enabled.enum, undefined);
      else assert.equal(sent.body, body);
    }
    assert.equal((await (await fetch(`${base}/health`)).json()).normalizedRequests, 1);
  } finally {
    await relay.close(); upstream.closeAllConnections();
    await new Promise(resolve => upstream.close(resolve));
  }
});
