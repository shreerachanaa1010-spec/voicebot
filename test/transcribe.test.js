import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { Readable } from 'node:stream';
import transcribeHandler from '../api/transcribe.js';

const originalFetch = globalThis.fetch;
const originalApiKey = process.env.GROQ_API_KEY;
const originalUpstashUrl = process.env.UPSTASH_REDIS_REST_URL;
const originalUpstashToken = process.env.UPSTASH_REDIS_REST_TOKEN;

function createResponse() {
  return {
    statusCode: 200,
    headers: {},
    body: undefined,
    status(code) {
      this.statusCode = code;
      return this;
    },
    setHeader(name, value) {
      this.headers[name.toLowerCase()] = value;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
    end() {
      return this;
    },
  };
}

function createAudioRequest({
  fieldName = 'audio',
  mimeType = 'audio/webm',
  audio = Buffer.from('fake audio'),
  address = `transcribe-${crypto.randomUUID()}`,
} = {}) {
  const boundary = 'voicebot-test-boundary';
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${fieldName}"; filename="recording.webm"\r\nContent-Type: ${mimeType}\r\n\r\n`),
    audio,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  const request = Readable.from([body]);
  request.method = 'POST';
  request.headers = {
    'content-type': `multipart/form-data; boundary=${boundary}`,
    'content-length': String(body.length),
    'x-forwarded-for': address,
  };
  return request;
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

test('transcribes a supported multipart audio upload', async () => {
  let upstreamForm;
  globalThis.fetch = async (url, options) => {
    assert.equal(url, 'https://api.groq.com/openai/v1/audio/transcriptions');
    assert.equal(options.headers.Authorization, 'Bearer test-key');
    upstreamForm = options.body;
    return { ok: true, json: async () => ({ text: 'Who is Rachana?' }) };
  };

  const response = createResponse();
  await transcribeHandler(createAudioRequest(), response);

  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.body, { text: 'Who is Rachana?' });
  assert.equal(upstreamForm.get('model'), 'whisper-large-v3-turbo');
  assert.equal(upstreamForm.get('file').type, 'audio/webm');
});

test('rejects unsupported audio formats', async () => {
  const response = createResponse();
  await transcribeHandler(createAudioRequest({ mimeType: 'application/octet-stream' }), response);
  assert.equal(response.statusCode, 415);
});

test('rejects audio uploads larger than four megabytes', async () => {
  const request = createAudioRequest({ audio: Buffer.alloc(4 * 1024 * 1024 + 1) });
  const response = createResponse();
  await transcribeHandler(request, response);
  assert.equal(response.statusCode, 413);
});