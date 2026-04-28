import 'dotenv/config';
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';
import { prettyJSON } from 'hono/pretty-json';

import { healthRouter } from './routes/health';
import { jobsRouter } from './routes/jobs';
import { voiceRouter } from './routes/voice';
import { quotesRouter } from './routes/quotes';

const app = new Hono();

// ─── Global Middleware ────────────────────────

app.use('*', logger());
app.use('*', prettyJSON());
app.use(
  '*',
  cors({
    origin: (origin) => origin ?? '*', // allow Expo Go tunnel + any client
    allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowHeaders: ['Content-Type', 'Authorization'],
    credentials: true,
  })
);

// ─── Routes ──────────────────────────────────

app.route('/health', healthRouter);
app.route('/api/v1/jobs', jobsRouter);
app.route('/api/v1/voice', voiceRouter);
app.route('/api/v1/quotes', quotesRouter);

// ─── 404 Handler ─────────────────────────────

app.notFound((c) => {
  return c.json({ error: { message: 'Route not found', code: 'NOT_FOUND' } }, 404);
});

// ─── Error Handler ───────────────────────────

app.onError((err, c) => {
  console.error('[TradePilot API Error]', err);
  return c.json(
    {
      error: {
        message: err.message || 'Internal server error',
        code: 'INTERNAL_ERROR',
      },
    },
    500
  );
});

// ─── Server ──────────────────────────────────

const PORT = parseInt(process.env.PORT ?? '3000', 10);

serve(
  {
    fetch: app.fetch,
    port: PORT,
  },
  (info) => {
    console.log(`\n🔧 TradePilot API running on http://localhost:${info.port}`);
    console.log(`📋 Health check: http://localhost:${info.port}/health\n`);
  }
);

export default app;
