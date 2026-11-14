import { PERSONA } from '../persona.js';
import { checkChatRateLimit } from '../lib/rate-limit.js';

const FALLBACK_REPLY = "I'm a bit busy right now. Could you ask that again in a moment?";

async function relayContentStream(response, res) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let pending = '';
  let sentContent = false;

  function relayLine(line) {
    if (!line.startsWith('data:')) return;
    const payload = line.slice(5).trim();
    if (!payload || payload === '[DONE]') return;

    try {
      const event = JSON.parse(payload);
      const content = event.choices?.[0]?.delta?.content;
      if (typeof content === 'string' && content) {
        res.write(`data: ${JSON.stringify({ content })}\n\n`);
        sentContent = true;
      }
    } catch {
      return;
    }
  }

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      pending += decoder.decode(value, { stream: true });
      const lines = pending.split(/\r?\n/);
      pending = lines.pop() || '';
      lines.forEach(relayLine);
    }
    pending += decoder.decode();
    if (pending.trim()) relayLine(pending);
  } finally {
    reader.releaseLock();
  }

  if (!sentContent) res.write(`data: ${JSON.stringify({ content: FALLBACK_REPLY })}\n\n`);
  res.write('data: [DONE]\n\n');
  res.end();
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey || apiKey === 'your_key_here') {
    return res.status(503).json({ reply: 'Add your Groq API key to .env and restart the server.' });
  }

  let rateLimit;
  try {
    rateLimit = await checkChatRateLimit(req);
  } catch {
    console.error('Shared chat rate limit is unavailable');
    return res.status(503).json({ reply: 'Chat is temporarily unavailable. Please try again soon.' });
  }

  res.setHeader('RateLimit-Limit', String(rateLimit.limit));
  res.setHeader('RateLimit-Remaining', String(rateLimit.remaining));
  if (!rateLimit.allowed) {
    res.setHeader('Retry-After', String(rateLimit.retryAfter));
    return res.status(429).json({ reply: 'Too many questions too quickly. Please try again in a minute.' });
  }

  let abortOnDisconnect;
  try {
    const incoming = req.body?.messages;
    if (!Array.isArray(incoming)) {
      return res.status(400).json({ reply: 'Please ask a question and try again.' });
    }

      const messages = incoming
        .slice(-6)
      .filter((message) => message && ['user', 'assistant'].includes(message.role))
      .map((message) => ({
        role: message.role,
        content: String(message.content || '').slice(0, 4000),
      }))
        .filter((message) => message.content.trim());

    if (!messages.length || messages[messages.length - 1].role !== 'user') {
      return res.status(400).json({ reply: 'Please ask a question and try again.' });
    }

    const controller = new AbortController();
    abortOnDisconnect = () => {
      if (!res.writableEnded) controller.abort();
    };
    res.on?.('close', abortOnDisconnect);

    const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: 'openai/gpt-oss-120b',
        temperature: 0.7,
        max_tokens: 200,
        stream: true,
        messages: [{ role: 'system', content: PERSONA }, ...messages],
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const data = await response.json();
      console.error('Groq request failed:', {
        status: response.status,
        type: data.error?.type,
        code: data.error?.code,
      });
      return res.status(502).json({ reply: FALLBACK_REPLY });
    }
    if (!response.body) {
      console.error('Groq response did not contain a stream');
      return res.status(502).json({ reply: FALLBACK_REPLY });
    }

    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.status(200);
      res.flushHeaders?.();
    await relayContentStream(response, res);
    res.off?.('close', abortOnDisconnect);
    return undefined;
  } catch {
    if (abortOnDisconnect) res.off?.('close', abortOnDisconnect);
    if (res.headersSent) return res.end();
    return res.status(500).json({ reply: 'Something went wrong on my side. Please try again.' });
  }
}