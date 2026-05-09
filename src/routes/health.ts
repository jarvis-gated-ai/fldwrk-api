import { Hono } from 'hono';
import { supabaseAdmin } from '../lib/supabase';

export const healthRouter = new Hono();

healthRouter.get('/', async (c) => {
  // Quick DB ping to verify Supabase connectivity
  let dbStatus: 'ok' | 'error' = 'ok';
  try {
    const { error } = await supabaseAdmin.from('companies').select('id').limit(1);
    if (error) dbStatus = 'error';
  } catch {
    dbStatus = 'error';
  }

  const status = dbStatus === 'ok' ? 'ok' : 'degraded';

  return c.json(
    {
      status,
      timestamp: new Date().toISOString(),
      version: '1.0.0',
      services: {
        database: dbStatus,
      },
    },
200
  );
});
