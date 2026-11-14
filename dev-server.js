import express from 'express';
import chatHandler from './api/chat.js';
import transcribeHandler from './api/transcribe.js';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const app = express();
const port = process.env.PORT || 3000;
const rootDirectory = dirname(fileURLToPath(import.meta.url));

app.use(express.json({ limit: '100kb' }));
app.post('/api/chat', chatHandler);
app.post('/api/transcribe', transcribeHandler);
app.use(express.static(rootDirectory));

app.listen(port, () => {
  console.log(`Voicebot is running at http://localhost:${port}`);
});