import 'dotenv/config';
import { serve } from '@hono/node-server';
import app from './app';

// ─── Local Dev Server ──────────────────────────────────────────────────────────

const PORT = parseInt(process.env.PORT ?? '3001', 10);

serve(
  {
    fetch: app.fetch,
    port: PORT,
  },
  (info) => {
    console.log(`\n🔧 FLDWRK API running on http://localhost:${info.port}`);
    console.log(`📋 Health check: http://localhost:${info.port}/health\n`);
  }
);

export default app;
