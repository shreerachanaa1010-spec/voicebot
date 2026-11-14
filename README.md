# Talk to Rachana

A voice-first interview demo that answers from Rachana's supplied persona. It uses Groq for Whisper transcription and streamed chat, browser speech synthesis for replies, Vercel serverless functions, and optional Upstash rate limiting.

Audio uploads are capped at 4 MB to fit within serverless request limits.

## Architecture

```mermaid
flowchart LR
  Visitor --> Browser[MediaRecorder and speech synthesis]
  Browser -->|audio| Transcribe[/api/transcribe]
  Transcribe --> Whisper[Groq Whisper]
  Whisper -->|transcript| Browser
  Browser -->|question and short history| Chat[/api/chat]
  Persona[persona.js] --> Chat
  Chat --> Model[Groq chat model]
  Chat --> Limit[Upstash per-IP limit]
  Model -->|sentence stream| Browser
```

Groq provides fast transcription and chat through one server-side API key. Vercel hosts the page and API functions; the key is never sent to the browser. The persona prompt keeps answers in first person and directs the model not to invent missing facts.

## Run Locally

Requires Node.js 20.6 or newer. Create `.env` with `GROQ_API_KEY` from [console.groq.com](https://console.groq.com/), then run:

```sh
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000). Allow microphone access or type a question. Run `npm test` for API, Whisper-upload, and rate-limit checks.

## Deploy

Import the repository into Vercel and set `GROQ_API_KEY`. For a shared 20-requests-per-minute limit across serverless instances, also set `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN`. Without Upstash, the local in-memory limiter is only per process. Never commit `.env` or put keys in `index.html`.

## Persona and Links

Review every personal detail and metric in `persona.js` before sharing the demo. Portfolio links are configured in `index.html`; add the real HTTPS URLs for GitHub, LinkedIn, resume, and Play Store. Unconfigured links stay hidden rather than pointing to placeholders.