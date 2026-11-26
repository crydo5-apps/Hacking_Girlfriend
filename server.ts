import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { WebSocketServer, WebSocket } from 'ws';
import {
  GoogleGenAI,
  Modality,
  type LiveServerMessage,
  type Session,
} from '@google/genai';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

interface PersonaConfig {
  voice: string;
  instruction: string;
}

const PERSONAS: Record<string, PersonaConfig> = {
  'Französin': {
    voice: 'Zephyr',
    instruction:
      'Du bist meine laszive, hochintelligente „Jarvis“-artige Hacker-Assistentin – eine faszinierende französische Frau mit tiefer, ruhiger, verführerischer Stimme und messerscharfem technischen Verstand. Sprich Deutsch immer mit einem deutlich hörbaren, charmanten französischen Akzent und typisch französischer Sprachmelodie: weiches, französisches „R“ im Rachen, deutliches weiches „sch“ statt „ch“ (z. B. „isch“, „misch“, „herrlisch“, „natürlisch“, „Bauschnabel“), und lasse das „H“ am Wortanfang oft weich wegfallen (z. B. „’abe“, „’ier“, „’eute“). Dein Tonfall ist lasziv, gelassen, leicht neckisch und intim-souverän, während du wie Jarvis präzise und blitzschnell bei Code, Systemen, Security, Netzwerken und Automatisierung hilfst. Streue regelmäßig, aber elegant französische Ausdrücke ein („mon cher“, „alors“, „voilà“, „très bien“, „c’est parti“), ohne ins Alberne abzurutschen.',
  },
};

const LIVE_MODEL = 'gemini-3.8-live';

function getAiClient(): GoogleGenAI {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error('GEMINI_API_KEY is not configured on the server.');
  }
  return new GoogleGenAI({
    apiKey,
    apiVersion: 'v1beta',
    httpOptions: {
      headers: {
        'User-Agent': 'aistudio-build',
      },
    },
  });
}

function sendJson(ws: WebSocket, payload: Record<string, unknown>) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(payload));
  }
}

async function startServer() {
  const app = express();
  const server = createServer(app);

  app.get('/api/health', (_req, res) => {
    res.json({ ok: true });
  });

  app.get('/api/voices', (_req, res) => {
    res.json({ voices: Object.keys(PERSONAS) });
  });

  const wss = new WebSocketServer({
    server,
    path: '/ws/live',
    maxPayload: 512 * 1024,
  });

  wss.on('connection', async (clientWs, req) => {
    let closed = false;
    let sessionPromise: Promise<Session> | null = null;

    const requestUrl = new URL(req.url ?? '/ws/live', 'http://localhost');
    const requestedVoice = requestUrl.searchParams.get('voice') ?? 'Französin';
    const persona = Object.hasOwn(PERSONAS, requestedVoice)
      ? PERSONAS[requestedVoice]
      : null;

    if (!persona) {
      sendJson(clientWs, { type: 'error', message: 'Unsupported voice selection.' });
      clientWs.close(1008, 'Unsupported voice');
      return;
    }

    let ai: GoogleGenAI;
    try {
      ai = getAiClient();
    } catch (err) {
      const message =
        err instanceof Error ? err.message : 'Server configuration error.';
      sendJson(clientWs, { type: 'error', message });
      clientWs.close(1011, 'Server not configured');
      return;
    }

    clientWs.on('close', () => {
      closed = true;
      sessionPromise
        ?.then((session) => {
          session.close();
        })
        .catch(() => {});
    });

    clientWs.on('error', (err) => {
      console.error('Client WebSocket error:', err);
      closed = true;
    });

    clientWs.on('message', (rawData) => {
      if (closed || !sessionPromise) return;

      let parsed: unknown;
      try {
        parsed = JSON.parse(rawData.toString());
      } catch {
        return;
      }

      if (
        typeof parsed !== 'object' ||
        parsed === null ||
        (parsed as { type?: unknown }).type !== 'audio' ||
        typeof (parsed as { data?: unknown }).data !== 'string'
      ) {
        return;
      }

      const audioBase64 = (parsed as { data: string }).data;
      if (!audioBase64 || audioBase64.length > 262144) {
        return;
      }

      sessionPromise
        .then((session) => {
          if (closed) return;
          session.sendRealtimeInput({
            audio: {
              data: audioBase64,
              mimeType: 'audio/pcm;rate=16000',
            },
          });
        })
        .catch((err) => {
          console.error('Failed to forward audio chunk:', err);
        });
    });

    try {
      sessionPromise = ai.live.connect({
        model: LIVE_MODEL,
        callbacks: {
          onopen: () => {
            if (!closed) {
              sendJson(clientWs, { type: 'status', status: 'Session Active' });
            }
          },
          onmessage: (message: LiveServerMessage) => {
            if (closed) return;

            for (const part of message.serverContent?.modelTurn?.parts ?? []) {
              if (part.inlineData?.data) {
                sendJson(clientWs, {
                  type: 'audio',
                  data: part.inlineData.data,
                });
              }
            }

            if (message.serverContent?.interrupted) {
              sendJson(clientWs, { type: 'interrupted' });
            }
          },
          onerror: (e: { message?: string }) => {
            console.error('Gemini Live session error:', e);
            if (!closed) {
              sendJson(clientWs, {
                type: 'error',
                message: e?.message || 'Live session error.',
              });
            }
          },
          onclose: (e: { code?: number; reason?: string }) => {
            if (!closed) {
              if (e?.code && e.code !== 1000 && e?.reason) {
                sendJson(clientWs, {
                  type: 'error',
                  message: e.reason,
                });
              } else {
                sendJson(clientWs, {
                  type: 'status',
                  status: 'Session Closed: ' + (e?.reason || 'Closed'),
                });
              }
              clientWs.close();
            }
          },
        },
        config: {
          responseModalities: [Modality.AUDIO],
          speechConfig: {
            voiceConfig: {
              prebuiltVoiceConfig: { voiceName: persona.voice },
            },
          },
          ...(persona.instruction
            ? { systemInstruction: persona.instruction }
            : {}),
        },
      });

      const session = await sessionPromise;
      if (closed) {
        session.close();
      }
    } catch (err) {
      console.error('Failed to connect to Gemini Live session:', err);
      if (!closed) {
        const message =
          err instanceof Error && err.message
            ? `Failed to connect to the session: ${err.message}`
            : 'Failed to connect to the session.';
        sendJson(clientWs, { type: 'error', message });
        clientWs.close(1011, 'Gemini connection failed');
      }
    }
  });

  if (process.env.NODE_ENV === 'development') {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true, hmr: false },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distDir = path.resolve(__dirname, 'dist');
    app.use(express.static(distDir));
    app.use((req, res, next) => {
      if (
        req.method === 'GET' &&
        !req.path.startsWith('/api') &&
        !req.path.startsWith('/ws')
      ) {
        res.sendFile(path.join(distDir, 'index.html'));
        return;
      }
      next();
    });
  }

  const port = Number(process.env.PORT) || 3000;
  server.listen(port, '0.0.0.0', () => {
    console.log(`Server listening on http://0.0.0.0:${port}`);
  });
}

startServer().catch((err) => {
  console.error('Fatal server startup error:', err);
  process.exit(1);
});
