import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';
import { prettyJSON } from 'hono/pretty-json';

import { healthRouter } from './routes/health';
import { jobsRouter } from './routes/jobs';
import { voiceRouter } from './routes/voice';
import { quotesRouter } from './routes/quotes';
import { customersRouter } from './routes/customers';
import { authRouter } from './routes/auth';
import { webhooksRouter } from './routes/webhooks';

const app = new Hono();

// ─── Global Middleware ────────────────────────

app.use('*', logger());
app.use('*', prettyJSON());
app.use(
  '*',
  cors({
    origin: (origin) => origin ?? '*',
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
app.route('/api/v1/customers', customersRouter);
app.route('/api/v1/auth', authRouter);
app.route('/api/v1/webhooks', webhooksRouter);

// ─── 404 Handler ─────────────────────────────

app.notFound((c) => {
  return c.json({ error: { message: 'Route not found', code: 'NOT_FOUND' } }, 404);
});

// ─── Error Handler ───────────────────────────

app.onError((err, c) => {
  console.error('[FLDWRK API Error]', err);
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

export default app;
