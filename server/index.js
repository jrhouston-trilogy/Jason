// JASON Amazon Agent — Express Server (local + Railway production)
// Local: node server/index.js
// Railway: deployed via Dockerfile

import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import crypto from 'crypto';
import {
  startAmazonOrder,
  confirmPurchase,
  submit2FACode,
  continueAfter2FA,
  resumeAfterIntervention,
  takeScreenshot,
  closeSession,
  getActiveSessions,
} from './amazon-agent.js';

const app = express();
const PORT = process.env.PORT || 3001;

// CORS: support multiple origins (comma-separated in ALLOWED_ORIGINS)
const allowedOrigins = (process.env.ALLOWED_ORIGINS || process.env.ALLOWED_ORIGIN || 'http://localhost:5173')
  .split(',')
  .map(o => o.trim());

app.use(cors({
  origin: (origin, callback) => {
    // Allow requests with no origin (curl, health checks)
    if (!origin) return callback(null, true);
    if (allowedOrigins.includes(origin) || allowedOrigins.includes('*')) {
      return callback(null, true);
    }
    console.warn(`CORS blocked origin: ${origin}`);
    callback(new Error('Not allowed by CORS'));
  },
  credentials: true,
}));

app.use(express.json({ limit: '1mb' }));

// Request logging
app.use((req, res, next) => {
  const ts = new Date().toISOString();
  console.log(`[${ts}] ${req.method} ${req.path}`);
  next();
});

// Helper: set up SSE response headers
function setupSSE(res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no', // Disable nginx/proxy buffering
  });

  const sendEvent = (data) => {
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  const onStatus = (status) => {
    sendEvent({ type: 'status', ...status });
  };

  return { sendEvent, onStatus };
}

// ---- Health & config (open CORS — no sensitive data) ----
app.get('/api/health', cors(), (req, res) => {
  const sessions = getActiveSessions();
  res.json({
    status: 'ok',
    service: 'jason-amazon-agent',
    version: '1.0.0',
    environment: process.env.RAILWAY_ENVIRONMENT || 'local',
    activeSessions: sessions.length,
    sessions,
    uptime: Math.round(process.uptime()),
  });
});

app.get('/api/config', cors(), (req, res) => {
  res.json({
    ready: !!(process.env.AMAZON_EMAIL && process.env.AMAZON_PASSWORD),
    features: ['magic-mode', 'sse', '2fa-relay'],
  });
});

// ---- SSE: Start Amazon Order ----
app.post('/api/amazon-order', (req, res) => {
  const { items } = req.body;

  if (!items || !Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: 'items array is required' });
  }

  const email = process.env.AMAZON_EMAIL;
  const password = process.env.AMAZON_PASSWORD;

  if (!email || !password) {
    return res.status(500).json({ error: 'AMAZON_EMAIL and AMAZON_PASSWORD must be configured' });
  }

  const sessionId = crypto.randomUUID();
  const { sendEvent, onStatus } = setupSSE(res);

  console.log(`[${sessionId.slice(0, 8)}] Starting order: ${items.length} items`);

  startAmazonOrder({ items, email, password, sessionId, onStatus })
    .then((result) => {
      sendEvent({ type: 'result', ...result });
      res.end();
    })
    .catch((err) => {
      console.error(`[${sessionId.slice(0, 8)}] Unhandled error:`, err);
      sendEvent({ type: 'result', status: 'error', reason: err.message });
      res.end();
    });

  req.on('close', () => {
    console.log(`[${sessionId.slice(0, 8)}] Client disconnected (session kept alive)`);
  });
});

// ---- Confirm purchase (after human approval) ----
app.post('/api/amazon-order/confirm', (req, res) => {
  const { sessionId } = req.body;
  if (!sessionId) return res.status(400).json({ error: 'sessionId is required' });

  const { sendEvent, onStatus } = setupSSE(res);

  confirmPurchase(sessionId, onStatus)
    .then((result) => {
      sendEvent({ type: 'result', ...result });
      res.end();
    })
    .catch((err) => {
      sendEvent({ type: 'result', status: 'error', reason: err.message });
      res.end();
    });
});

// ---- Submit 2FA verification code ----
app.post('/api/amazon-order/2fa', (req, res) => {
  const { sessionId, code } = req.body;
  if (!sessionId || !code) {
    return res.status(400).json({ error: 'sessionId and code are required' });
  }

  const { sendEvent, onStatus } = setupSSE(res);

  submit2FACode(sessionId, code, onStatus)
    .then((result) => {
      sendEvent({ type: 'result', ...result });
      res.end();
    })
    .catch((err) => {
      sendEvent({ type: 'result', status: 'error', reason: err.message });
      res.end();
    });
});

// ---- Continue order after 2FA resolved ----
app.post('/api/amazon-order/continue', (req, res) => {
  const { sessionId, items } = req.body;
  if (!sessionId || !items) {
    return res.status(400).json({ error: 'sessionId and items are required' });
  }

  const { sendEvent, onStatus } = setupSSE(res);

  continueAfter2FA(sessionId, items, onStatus)
    .then((result) => {
      sendEvent({ type: 'result', ...result });
      res.end();
    })
    .catch((err) => {
      sendEvent({ type: 'result', status: 'error', reason: err.message });
      res.end();
    });
});

// ---- Resume after manual intervention ----
app.post('/api/amazon-order/resume', (req, res) => {
  const { sessionId } = req.body;
  if (!sessionId) return res.status(400).json({ error: 'sessionId is required' });

  const { sendEvent, onStatus } = setupSSE(res);

  resumeAfterIntervention(sessionId, onStatus)
    .then((result) => {
      sendEvent({ type: 'result', ...result });
      res.end();
    })
    .catch((err) => {
      sendEvent({ type: 'result', status: 'error', reason: err.message });
      res.end();
    });
});

// ---- Get current screenshot ----
app.get('/api/amazon-order/screenshot/:sessionId', async (req, res) => {
  const screenshot = await takeScreenshot(req.params.sessionId);
  if (!screenshot) {
    return res.status(404).json({ error: 'Session not found or screenshot failed' });
  }
  res.json({ screenshot });
});

// ---- Close session ----
app.delete('/api/amazon-order/:sessionId', async (req, res) => {
  await closeSession(req.params.sessionId);
  res.json({ ok: true });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`=== JASON Amazon Agent ===`);
  console.log(`Port: ${PORT}`);
  console.log(`Environment: ${process.env.RAILWAY_ENVIRONMENT || 'local'}`);
  console.log(`Allowed origins: ${allowedOrigins.join(', ')}`);
  console.log(`Amazon email: ${process.env.AMAZON_EMAIL || '(not set)'}`);
  console.log(`Headless: ${process.env.NODE_ENV === 'production' || !!process.env.RAILWAY_ENVIRONMENT}`);
  console.log(`========================`);
});
