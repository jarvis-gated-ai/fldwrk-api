import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { authMiddleware, AuthVariables } from '../middleware/auth';
import { createUserClient, isSchemaError } from '../lib/supabase';

export const jobsRouter = new Hono<{ Variables: AuthVariables }>();

// Apply auth to all job routes
jobsRouter.use('*', authMiddleware);

// ─── Validation Schemas ───────────────────────

const createJobSchema = z.object({
  customer_id: z.string().uuid(),
  title: z.string().min(1).max(255),
  status: z.enum(['pending', 'scheduled', 'in_progress', 'completed', 'cancelled']).optional(),
  scheduled_at: z.string().datetime().optional().nullable(),
  notes: z.string().optional().nullable(),
});

const updateJobSchema = createJobSchema
  .partial()
  .extend({
    completed_at: z.string().datetime().optional().nullable(),
  });

const paginationSchema = z.object({
  page:        z.coerce.number().int().min(1).default(1),
  per_page:    z.coerce.number().int().min(1).max(100).default(20),
  status:      z.enum(['pending', 'scheduled', 'in_progress', 'completed', 'cancelled']).optional(),
  customer_id: z.string().uuid().optional(),
});

// ─── GET /api/v1/jobs ─────────────────────────

jobsRouter.get('/', zValidator('query', paginationSchema), async (c) => {
  const { page, per_page, status, customer_id } = c.req.valid('query');
  const jwt = c.get('jwt');
  const supabase = createUserClient(jwt);

  const from = (page - 1) * per_page;
  const to = from + per_page - 1;

  let query = supabase
    .from('jobs')
    .select('*, customer:customers(id, name, phone, email)', { count: 'exact' })
    .order('scheduled_at', { ascending: true, nullsFirst: false })
    .order('created_at', { ascending: false })
    .range(from, to);

  if (status)      query = query.eq('status', status);
  if (customer_id) query = query.eq('customer_id', customer_id);

  const { data, error, count } = await query;

  if (error) {
    if (isSchemaError(error)) return c.json({ data: [], total: 0, page, per_page, total_pages: 0 });
    return c.json({ error: { message: error.message, code: 'DB_ERROR' } }, 500);
  }

  return c.json({
    data,
    total: count ?? 0,
    page,
    per_page,
    total_pages: Math.ceil((count ?? 0) / per_page),
  });
});

// ─── GET /api/v1/jobs/:id ─────────────────────

jobsRouter.get('/:id', async (c) => {
  const id = c.req.param('id');
  const jwt = c.get('jwt');
  const supabase = createUserClient(jwt);

  const { data, error } = await supabase
    .from('jobs')
    .select(
      `
      *,
      customer:customers(id, name, phone, email, address),
      voice_logs(id, transcript, summary, audio_url, created_at),
      quotes(id, total_cents, status, line_items, created_at)
      `
    )
    .eq('id', id)
    .single();

  if (error) {
    if (error.code === 'PGRST116') {
      return c.json({ error: { message: 'Job not found', code: 'NOT_FOUND' } }, 404);
    }
    return c.json({ error: { message: error.message, code: 'DB_ERROR' } }, 500);
  }

  return c.json({ data });
});

// ─── POST /api/v1/jobs ────────────────────────

jobsRouter.post('/', zValidator('json', createJobSchema), async (c) => {
  const body = c.req.valid('json');
  const jwt = c.get('jwt');
  const companyId = c.get('companyId');
  const supabase = createUserClient(jwt);

  const { data, error } = await supabase
    .from('jobs')
    .insert({
      ...body,
      company_id: companyId,
      status: body.status ?? 'pending',
    })
    .select()
    .single();

  if (error) {
    return c.json({ error: { message: error.message, code: 'DB_ERROR' } }, 500);
  }

  return c.json({ data }, 201);
});

// ─── PATCH /api/v1/jobs/:id ───────────────────

jobsRouter.patch('/:id', zValidator('json', updateJobSchema), async (c) => {
  const id = c.req.param('id');
  const body = c.req.valid('json');
  const jwt = c.get('jwt');
  const supabase = createUserClient(jwt);

  // Auto-set completed_at when status transitions to completed
  const updates: Record<string, unknown> = { ...body };
  if (body.status === 'completed' && !body.completed_at) {
    updates.completed_at = new Date().toISOString();
  }

  const { data, error } = await supabase
    .from('jobs')
    .update(updates)
    .eq('id', id)
    .select()
    .single();

  if (error) {
    if (error.code === 'PGRST116') {
      return c.json({ error: { message: 'Job not found', code: 'NOT_FOUND' } }, 404);
    }
    return c.json({ error: { message: error.message, code: 'DB_ERROR' } }, 500);
  }

  return c.json({ data });
});

// ─── DELETE /api/v1/jobs/:id ──────────────────

jobsRouter.delete('/:id', async (c) => {
  const id = c.req.param('id');
  const jwt = c.get('jwt');
  const userRole = c.get('userRole');
  const supabase = createUserClient(jwt);

  if (!['owner', 'admin'].includes(userRole)) {
    return c.json({ error: { message: 'Insufficient permissions', code: 'FORBIDDEN' } }, 403);
  }

  const { error } = await supabase.from('jobs').delete().eq('id', id);

  if (error) {
    return c.json({ error: { message: error.message, code: 'DB_ERROR' } }, 500);
  }

  return c.json({ data: { success: true } });
});
