import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import OpenAI from 'openai';
import { authMiddleware, AuthVariables } from '../middleware/auth';
import { createUserClient, isSchemaError } from '../lib/supabase';

export const quotesRouter = new Hono<{ Variables: AuthVariables }>();

quotesRouter.use('*', authMiddleware);

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

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

// ─── POST /api/v1/quotes/generate ──────────────
// MUST be registered before /:id to avoid route conflict

const generateSchema = z.object({
  job_id:     z.string().uuid(),
  transcript: z.string().min(1),
});

quotesRouter.post('/generate', zValidator('json', generateSchema), async (c) => {
  const { job_id, transcript } = c.req.valid('json');
  const jwt      = c.get('jwt');
  const supabase = createUserClient(jwt);

  // Ask GPT-4o to extract line items from the transcript
  const completion = await openai.chat.completions.create({
    model: 'gpt-4o',
    max_tokens: 1024,
    messages: [
      {
        role: 'system',
        content:
          'You are a field service quoting assistant. Given a technician\'s voice transcript, ' +
          'extract up to 8 line items for a service quote. ' +
          'Return ONLY a valid JSON array with no markdown or explanation. ' +
          'Each element must have: description (string), quantity (integer >= 1), ' +
          'unit_price_cents (integer >= 0), total_cents (integer >= 0). ' +
          'total_cents must equal quantity * unit_price_cents.',
      },
      {
        role: 'user',
        content: `Transcript: ${transcript}`,
      },
    ],
  });

  let lineItems: Array<{
    description:    string;
    quantity:       number;
    unit_price_cents: number;
    total_cents:    number;
  }>;

  try {
    const raw = completion.choices[0]?.message?.content ?? '[]';
    lineItems = JSON.parse(raw);
    if (!Array.isArray(lineItems)) throw new Error('Not an array');
    // Clamp to 8 items and ensure total_cents is correct
    lineItems = lineItems.slice(0, 8).map((item) => ({
      ...item,
      total_cents: item.quantity * item.unit_price_cents,
    }));
  } catch {
    return c.json({ error: { message: 'AI returned invalid JSON', code: 'AI_PARSE_ERROR' } }, 500);
  }

  const total_cents = lineItems.reduce((sum, item) => sum + item.total_cents, 0);

  const { data, error } = await supabase
    .from('quotes')
    .insert({
      job_id,
      line_items:  lineItems,
      total_cents,
      status:      'draft',
    })
    .select()
    .single();

  if (error) {
    return c.json({ error: { message: error.message, code: 'DB_ERROR' } }, 500);
  }

  return c.json({ data }, 201);
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
    if (isSchemaError(error)) return c.json({ data: [] });
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
