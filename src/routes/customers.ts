import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { authMiddleware, AuthVariables } from '../middleware/auth';
import { createUserClient, isSchemaError } from '../lib/supabase';

export const customersRouter = new Hono<{ Variables: AuthVariables }>();

customersRouter.use('*', authMiddleware);

// ─── Validation Schemas ───────────────────────

const createCustomerSchema = z.object({
  name:    z.string().min(1).max(255),
  phone:   z.string().max(50).optional().nullable(),
  email:   z.string().email().optional().nullable(),
  address: z.string().max(500).optional().nullable(),
  notes:   z.string().optional().nullable(),
});

const updateCustomerSchema = createCustomerSchema.partial();

const listQuerySchema = z.object({
  search:   z.string().optional(),
  page:     z.coerce.number().int().min(1).default(1),
  per_page: z.coerce.number().int().min(1).max(100).default(50),
});

// ─── GET /api/v1/customers ────────────────────

customersRouter.get('/', zValidator('query', listQuerySchema), async (c) => {
  const { search, page, per_page } = c.req.valid('query');
  const jwt = c.get('jwt');
  const supabase = createUserClient(jwt);

  const from = (page - 1) * per_page;
  const to   = from + per_page - 1;

  let query = supabase
    .from('customers')
    .select('*, jobs(id)', { count: 'exact' })
    .order('name', { ascending: true })
    .range(from, to);

  if (search) {
    query = query.or(
      `name.ilike.%${search}%,phone.ilike.%${search}%,email.ilike.%${search}%`
    );
  }

  const { data, error, count } = await query;

  if (error) {
    if (isSchemaError(error)) return c.json({ data: [] });
    return c.json({ error: { message: error.message, code: 'DB_ERROR' } }, 500);
  }

  // Annotate each customer with a job_count
  const enriched = (data ?? []).map((customer) => ({
    ...customer,
    job_count: Array.isArray(customer.jobs) ? customer.jobs.length : 0,
    jobs: undefined,
  }));

  return c.json({
    data: enriched,
    total: count ?? 0,
    page,
    per_page,
    total_pages: Math.ceil((count ?? 0) / per_page),
  });
});

// ─── GET /api/v1/customers/:id ────────────────

customersRouter.get('/:id', async (c) => {
  const id  = c.req.param('id');
  const jwt = c.get('jwt');
  const supabase = createUserClient(jwt);

  const { data, error } = await supabase
    .from('customers')
    .select(`*, jobs(id, title, status, scheduled_at, created_at)`)
    .eq('id', id)
    .single();

  if (error) {
    if (error.code === 'PGRST116') {
      return c.json({ error: { message: 'Customer not found', code: 'NOT_FOUND' } }, 404);
    }
    return c.json({ error: { message: error.message, code: 'DB_ERROR' } }, 500);
  }

  const enriched = {
    ...data,
    job_count: Array.isArray(data.jobs) ? data.jobs.length : 0,
  };

  return c.json({ data: enriched });
});

// ─── POST /api/v1/customers ───────────────────

customersRouter.post('/', zValidator('json', createCustomerSchema), async (c) => {
  const body      = c.req.valid('json');
  const jwt       = c.get('jwt');
  const companyId = c.get('companyId');
  const supabase  = createUserClient(jwt);

  const { data, error } = await supabase
    .from('customers')
    .insert({ ...body, company_id: companyId })
    .select()
    .single();

  if (error) {
    return c.json({ error: { message: error.message, code: 'DB_ERROR' } }, 500);
  }

  return c.json({ data }, 201);
});

// ─── PATCH /api/v1/customers/:id ─────────────

customersRouter.patch('/:id', zValidator('json', updateCustomerSchema), async (c) => {
  const id       = c.req.param('id');
  const body     = c.req.valid('json');
  const jwt      = c.get('jwt');
  const supabase = createUserClient(jwt);

  const { data, error } = await supabase
    .from('customers')
    .update(body)
    .eq('id', id)
    .select()
    .single();

  if (error) {
    if (error.code === 'PGRST116') {
      return c.json({ error: { message: 'Customer not found', code: 'NOT_FOUND' } }, 404);
    }
    return c.json({ error: { message: error.message, code: 'DB_ERROR' } }, 500);
  }

  return c.json({ data });
});

// ─── DELETE /api/v1/customers/:id ────────────

customersRouter.delete('/:id', async (c) => {
  const id       = c.req.param('id');
  const jwt      = c.get('jwt');
  const userRole = c.get('userRole');
  const supabase = createUserClient(jwt);

  if (!['owner', 'admin'].includes(userRole)) {
    return c.json({ error: { message: 'Insufficient permissions', code: 'FORBIDDEN' } }, 403);
  }

  const { error } = await supabase.from('customers').delete().eq('id', id);

  if (error) {
    return c.json({ error: { message: error.message, code: 'DB_ERROR' } }, 500);
  }

  return c.json({ data: { success: true } });
});
