import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { authMiddleware, AuthVariables } from '../middleware/auth';
import { createUserClient } from '../lib/supabase';

export const quotesRouter = new Hono<{ Variables: AuthVariables }>();

quotesRouter.use('*', authMiddleware);

// ─── Validation Schemas ───────────────────────

const lineItemSchema = z.object({
  description: z.string().min(1),
  quantity: z.number().int().min(1),
  unit_price_cents: z.number().int().min(0),
  total_cents: z.number().int().min(0),
});

const createQuoteSchema = z.object({
  job_id: z.string().uuid(),
  line_items: z.array(lineItemSchema).min(1),
  status: z.enum(['draft', 'sent', 'accepted', 'rejected', 'expired']).optional(),
});

const updateQuoteSchema = z.object({
  line_items: z.array(lineItemSchema).optional(),
  status: z.enum(['draft', 'sent', 'accepted', 'rejected', 'expired']).optional(),
});

// ─── GET /api/v1/quotes ───────────────────────

quotesRouter.get('/', async (c) => {
  const jwt = c.get('jwt');
  const supabase = createUserClient(jwt);

  const statusFilter = c.req.query('status');
  const jobIdFilter = c.req.query('job_id');

  let query = supabase
    .from('quotes')
    .select(
      `
      *,
      job:jobs(id, title, status, customer:customers(id, name))
      `
    )
    .order('created_at', { ascending: false });

  if (statusFilter) {
    query = query.eq('status', statusFilter);
  }
  if (jobIdFilter) {
    query = query.eq('job_id', jobIdFilter);
  }

  const { data, error } = await query;

  if (error) {
    return c.json({ error: { message: error.message, code: 'DB_ERROR' } }, 500);
  }

  return c.json({ data });
});

// ─── GET /api/v1/quotes/:id ───────────────────

quotesRouter.get('/:id', async (c) => {
  const id = c.req.param('id');
  const jwt = c.get('jwt');
  const supabase = createUserClient(jwt);

  const { data, error } = await supabase
    .from('quotes')
    .select(
      `
      *,
      job:jobs(
        id, title, status, notes,
        customer:customers(id, name, phone, email, address)
      )
      `
    )
    .eq('id', id)
    .single();

  if (error) {
    if (error.code === 'PGRST116') {
      return c.json({ error: { message: 'Quote not found', code: 'NOT_FOUND' } }, 404);
    }
    return c.json({ error: { message: error.message, code: 'DB_ERROR' } }, 500);
  }

  return c.json({ data });
});

// ─── POST /api/v1/quotes ──────────────────────

quotesRouter.post('/', zValidator('json', createQuoteSchema), async (c) => {
  const body = c.req.valid('json');
  const jwt = c.get('jwt');
  const supabase = createUserClient(jwt);

  // Calculate total from line items
  const total_cents = body.line_items.reduce((sum, item) => sum + item.total_cents, 0);

  const { data, error } = await supabase
    .from('quotes')
    .insert({
      job_id: body.job_id,
      line_items: body.line_items,
      total_cents,
      status: body.status ?? 'draft',
    })
    .select()
    .single();

  if (error) {
    return c.json({ error: { message: error.message, code: 'DB_ERROR' } }, 500);
  }

  return c.json({ data }, 201);
});

// ─── PATCH /api/v1/quotes/:id ─────────────────

quotesRouter.patch('/:id', zValidator('json', updateQuoteSchema), async (c) => {
  const id = c.req.param('id');
  const body = c.req.valid('json');
  const jwt = c.get('jwt');
  const supabase = createUserClient(jwt);

  const updates: Record<string, unknown> = { ...body };

  // Recalculate total if line items changed
  if (body.line_items) {
    updates.total_cents = body.line_items.reduce((sum, item) => sum + item.total_cents, 0);
  }

  const { data, error } = await supabase
    .from('quotes')
    .update(updates)
    .eq('id', id)
    .select()
    .single();

  if (error) {
    if (error.code === 'PGRST116') {
      return c.json({ error: { message: 'Quote not found', code: 'NOT_FOUND' } }, 404);
    }
    return c.json({ error: { message: error.message, code: 'DB_ERROR' } }, 500);
  }

  return c.json({ data });
});

// ─── DELETE /api/v1/quotes/:id ────────────────

quotesRouter.delete('/:id', async (c) => {
  const id = c.req.param('id');
  const jwt = c.get('jwt');
  const userRole = c.get('userRole');
  const supabase = createUserClient(jwt);

  if (!['owner', 'admin'].includes(userRole)) {
    return c.json({ error: { message: 'Insufficient permissions', code: 'FORBIDDEN' } }, 403);
  }

  const { error } = await supabase.from('quotes').delete().eq('id', id);

  if (error) {
    return c.json({ error: { message: error.message, code: 'DB_ERROR' } }, 500);
  }

  return c.json({ data: { success: true } });
});
