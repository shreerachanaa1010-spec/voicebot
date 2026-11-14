import Busboy from 'busboy';
import { Buffer } from 'node:buffer';
import { checkChatRateLimit } from '../lib/rate-limit.js';

const MAX_AUDIO_BYTES = 4 * 1024 * 1024;
const FALLBACK_ERROR = 'I could not transcribe that recording. Please try again or type your question.';
const AUDIO_EXTENSIONS = new Map([
  ['audio/aac', 'aac'],
  ['audio/mp4', 'mp4'],
  ['audio/mpeg', 'mp3'],
  ['audio/ogg', 'ogg'],
  ['audio/wav', 'wav'],
  ['audio/webm', 'webm'],
  ['audio/x-m4a', 'm4a'],
]);

export const config = { api: { bodyParser: false } };

function parseAudio(request) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let fileCount = 0;
    let audio;
    const fail = (message, statusCode = 400) => {
      if (settled) return;
      settled = true;
      const error = new Error(message);
      error.statusCode = statusCode;
      reject(error);
    };

    let parser;
    try {
      parser = Busboy({
        headers: request.headers,
        limits: { fileSize: MAX_AUDIO_BYTES, files: 1, fields: 0, parts: 1 },
      });
    } catch {
      fail('Send the recording as a multipart audio file.');
      return;
    }

    parser.on('file', (fieldName, file, info) => {
      fileCount += 1;
      const mimeType = String(info.mimeType || '').split(';')[0].toLowerCase();
      const extension = AUDIO_EXTENSIONS.get(mimeType);
      if (fieldName !== 'audio' || fileCount > 1 || !extension) {
        file.resume();
        fail('Use a supported audio recording format.', 415);
        return;
      }

      const chunks = [];
      file.on('data', (chunk) => chunks.push(chunk));
      file.on('limit', () => fail('The recording is too large. Keep it under 4 MB.', 413));
      file.on('end', () => {
        if (file.truncated) {
          fail('The recording is too large. Keep it under 4 MB.', 413);
          return;
        }
        audio = { buffer: Buffer.concat(chunks), mimeType, extension };
      });
    });
    parser.on('filesLimit', () => fail('Send one audio recording at a time.'));
    parser.on('fieldsLimit', () => fail('Unexpected form fields in audio upload.'));
    parser.on('error', () => fail('The audio upload could not be read.'));
    parser.on('finish', () => {
      if (settled) return;
      if (!audio?.buffer.length) {
        fail('No audio was recorded. Tap to try again.');
        return;
      }
      settled = true;
      resolve(audio);
    });

    request.pipe(parser);
  });
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey || apiKey === 'your_key_here') {
    return res.status(503).json({ error: 'Add your Groq API key to .env and restart the server.' });
  }

  let rateLimit;
  try {
    rateLimit = await checkChatRateLimit(req);
  } catch {
    console.error('Shared transcription rate limit is unavailable');
    return res.status(503).json({ error: 'Voice transcription is temporarily unavailable.' });
  }

  res.setHeader('RateLimit-Limit', String(rateLimit.limit));
  res.setHeader('RateLimit-Remaining', String(rateLimit.remaining));
  if (!rateLimit.allowed) {
    res.setHeader('Retry-After', String(rateLimit.retryAfter));
    return res.status(429).json({ error: 'Too many questions too quickly. Please try again in a minute.' });
  }

  const contentLength = Number(req.headers['content-length'] || 0);
  if (contentLength > MAX_AUDIO_BYTES + 64 * 1024) {
    return res.status(413).json({ error: 'The recording is too large. Keep it under 4 MB.' });
  }

  let audio;
  try {
    audio = await parseAudio(req);
  } catch (error) {
    return res.status(error.statusCode || 400).json({ error: error.message });
  }

  try {
    const form = new FormData();
    form.append('file', new Blob([audio.buffer], { type: audio.mimeType }), `question.${audio.extension}`);
    form.append('model', 'whisper-large-v3-turbo');
    form.append('language', 'en');

    const response = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}` },
      body: form,
      signal: AbortSignal.timeout(25_000),
    });
    const data = await response.json();
    if (!response.ok) {
      console.error('Groq transcription failed:', {
        status: response.status,
        type: data.error?.type,
        code: data.error?.code,
      });
      return res.status(502).json({ error: FALLBACK_ERROR });
    }

    return res.json({ text: String(data.text || '').trim() });
  } catch {
    return res.status(502).json({ error: FALLBACK_ERROR });
  }
}