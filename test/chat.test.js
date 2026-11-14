import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import chatHandler from '../api/chat.js';

const originalFetch = globalThis.fetch;
const originalApiKey = process.env.GROQ_API_KEY;
const originalUpstashUrl = process.env.UPSTASH_REDIS_REST_URL;
const originalUpstashToken = process.env.UPSTASH_REDIS_REST_TOKEN;

function createResponse() {
  return {
    statusCode: 200,
    headers: {},
    body: undefined,
    ended: false,
    output: '',
    status(code) {
      this.statusCode = code;
      return this;
    },
    setHeader(name, value) {
      this.headers[name.toLowerCase()] = value;
      return this;
    },
    write(chunk) {
      this.output += chunk;
      this.headersSent = true;
      return true;
    },
    json(body) {
      this.body = body;
      return this;
    },
    end() {
      this.ended = true;
      return this;
    },
  };
}

function createRequest({ method = 'POST', messages, address = `test-${crypto.randomUUID()}` } = {}) {
  return {
    method,
    headers: { 'x-forwarded-for': address },
    body: messages === undefined ? undefined : { messages },
  };
}

function createGroqStream(events) {
  return new ReadableStream({
    start(controller) {
      for (const event of events) controller.enqueue(new TextEncoder().encode(event));
      controller.close();
    },
  });
}

beforeEach(() => {
  process.env.GROQ_API_KEY = 'test-key';
  delete process.env.UPSTASH_REDIS_REST_URL;
  delete process.env.UPSTASH_REDIS_REST_TOKEN;
  globalThis.fetch = originalFetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalApiKey === undefined) delete process.env.GROQ_API_KEY;
  else process.env.GROQ_API_KEY = originalApiKey;
  if (originalUpstashUrl === undefined) delete process.env.UPSTASH_REDIS_REST_URL;
  else process.env.UPSTASH_REDIS_REST_URL = originalUpstashUrl;
  if (originalUpstashToken === undefined) delete process.env.UPSTASH_REDIS_REST_TOKEN;
  else process.env.UPSTASH_REDIS_REST_TOKEN = originalUpstashToken;
});

test('rejects non-POST requests', async () => {
  const response = createResponse();
  await chatHandler(createRequest({ method: 'GET' }), response);
  assert.equal(response.statusCode, 405);
  assert.equal(response.ended, true);
});

test('requires a Groq API key', async () => {
  delete process.env.GROQ_API_KEY;
  const response = createResponse();
  await chatHandler(createRequest(), response);
  assert.equal(response.statusCode, 503);
});

test('rejects requests without a messages array', async () => {
  const response = createResponse();
  await chatHandler(createRequest(), response);
  assert.equal(response.statusCode, 400);
});

test('forwards only the last six valid messages and returns the reply', async () => {
  const messages = [
    { role: 'user', content: 'first' },
    { role: 'assistant', content: 'second' },
    { role: 'user', content: 'third' },
    { role: 'assistant', content: 'fourth' },
    { role: 'user', content: 'fifth' },
    { role: 'assistant', content: 'sixth' },
    { role: 'user', content: 'seventh' },
  ];
  let upstreamBody;
  globalThis.fetch = async (url, options) => {
    assert.equal(url, 'https://api.groq.com/openai/v1/chat/completions');
    assert.equal(options.headers.Authorization, 'Bearer test-key');
    upstreamBody = JSON.parse(options.body);
    return {
      ok: true,
      status: 200,
      body: createGroqStream([
        'data: {"choices":[{"delta":{"content":"Hello from "}}]}\n\n',
        'data: {"choices":[{"delta":{"reasoning":"private reasoning"}}]}\n\n',
        'data: {"choices":[{"delta":{"content":"Rachana."}}]}\n\n',
        'data: [DONE]\n\n',
      ]),
    };
  };

  const response = createResponse();
  await chatHandler(createRequest({ messages }), response);

  assert.equal(response.statusCode, 200);
  assert.equal(response.ended, true);
  assert.equal(response.headers['content-type'], 'text/event-stream; charset=utf-8');
  assert.match(response.output, /"content":"Hello from "/);
  assert.match(response.output, /"content":"Rachana\."/);
  assert.doesNotMatch(response.output, /private reasoning/);
  assert.match(response.output, /data: \[DONE\]/);
  assert.equal(upstreamBody.model, 'openai/gpt-oss-120b');
  assert.equal(upstreamBody.stream, true);
  assert.deepEqual(upstreamBody.messages.slice(1), messages.slice(-6));
});

test('limits each client to twenty requests per minute', async () => {
  const address = `rate-test-${crypto.randomUUID()}`;

  for (let attempt = 0; attempt < 20; attempt += 1) {
    const response = createResponse();
    await chatHandler(createRequest({ address, messages: [] }), response);
    assert.equal(response.statusCode, 400);
  }

  const response = createResponse();
  await chatHandler(createRequest({ address, messages: [] }), response);
  assert.equal(response.statusCode, 429);
  assert.equal(response.headers['retry-after'], '60');
});