import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { supabaseAdmin } from '../lib/supabase';
import { authMiddleware, AuthVariables } from '../middleware/auth';

export const authRouter = new Hono<{ Variables: AuthVariables }>();

// ─── Validation Schemas ───────────────────────

const registerSchema = z.object({
  email:        z.string().email(),
  full_name:    z.string().min(1).max(255),
  company_name: z.string().min(1).max(255),
});

// ─── POST /api/v1/auth/register ──────────────
// Creates a company + user record and sends a magic link OTP.

authRouter.post('/register', zValidator('json', registerSchema), async (c) => {
  const { email, full_name, company_name } = c.req.valid('json');

  // 1. Invite the user via Supabase Auth (creates auth.users row)
  //    Using signInWithOtp so the user gets a magic link to verify their email.
  const { error: otpError } = await supabaseAdmin.auth.admin.inviteUserByEmail(email, {
    data: { full_name },
  });

  if (otpError) {
    // If user already exists, just send a new OTP instead
    if (otpError.message.includes('already been registered') || otpError.status === 422) {
      const { error: signInError } = await supabaseAdmin.auth.signInWithOtp({ email });
      if (signInError) {
        return c.json({ error: { message: signInError.message, code: 'AUTH_ERROR' } }, 400);
      }
      return c.json({ message: 'Check your email' });
    }
    return c.json({ error: { message: otpError.message, code: 'AUTH_ERROR' } }, 400);
  }

  // 2. Fetch the newly created auth user to get their UUID
  const { data: { users }, error: listError } = await supabaseAdmin.auth.admin.listUsers();
  if (listError) {
    return c.json({ error: { message: listError.message, code: 'AUTH_ERROR' } }, 500);
  }

  const authUser = users.find((u) => u.email === email);
  if (!authUser) {
    return c.json({ error: { message: 'User creation failed', code: 'AUTH_ERROR' } }, 500);
  }

  // 3. Check if a user record already exists (idempotent)
  const { data: existingUser } = await supabaseAdmin
    .from('users')
    .select('id')
    .eq('id', authUser.id)
    .single();

  if (!existingUser) {
    // 4. Create the company
    const { data: company, error: companyError } = await supabaseAdmin
      .from('companies')
      .insert({ name: company_name })
      .select()
      .single();

    if (companyError) {
      return c.json({ error: { message: companyError.message, code: 'DB_ERROR' } }, 500);
    }

    // 5. Create the user profile linked to the company
    const { error: userError } = await supabaseAdmin
      .from('users')
      .insert({
        id:         authUser.id,
        email,
        full_name,
        company_id: company.id,
        role:       'owner',
      });

    if (userError) {
      return c.json({ error: { message: userError.message, code: 'DB_ERROR' } }, 500);
    }
  }

  return c.json({ message: 'Check your email' });
});

// ─── GET /api/v1/auth/me ─────────────
// Returns the authenticated user's profile + company info.

authRouter.get('/me', authMiddleware, async (c) => {
  const userId    = c.get('userId');
  const companyId = c.get('companyId');

  const { data: user, error } = await supabaseAdmin
    .from('users')
    .select('id, email, full_name, role, company_id, created_at, company:companies(id, name)')
    .eq('id', userId)
    .single();

  if (error || !user) {
    return c.json({ error: { message: 'Profile not found', code: 'NOT_FOUND' } }, 404);
  }

  return c.json({ data: user });
});

// ─── PATCH /api/v1/auth/me ────────────
// Update the authenticated user's own profile.

const updateMeSchema = z.object({
  full_name:    z.string().min(1).max(255).optional(),
  phone:        z.string().max(30).optional(),
  company_name: z.string().min(1).max(255).optional(),
});

authRouter.patch('/me', authMiddleware, zValidator('json', updateMeSchema), async (c) => {
  const userId    = c.get('userId');
  const companyId = c.get('companyId');
  const { company_name, ...userFields } = c.req.valid('json');

  // Update user profile fields (full_name, phone)
  const userUpdate: Record<string, unknown> = {};
  if (userFields.full_name) userUpdate.full_name = userFields.full_name;
  if (userFields.phone !== undefined) userUpdate.phone = userFields.phone;

  if (Object.keys(userUpdate).length > 0) {
    const { error: userErr } = await supabaseAdmin
      .from('users')
      .update(userUpdate)
      .eq('id', userId);

    if (userErr) {
      // If phone column doesn't exist yet, fall back to updating only known fields
      if (userErr.message.includes('phone')) {
        delete userUpdate.phone;
        if (Object.keys(userUpdate).length > 0) {
          await supabaseAdmin.from('users').update(userUpdate).eq('id', userId);
        }
      } else {
        return c.json({ error: { message: userErr.message, code: 'DB_ERROR' } }, 500);
      }
    }
  }

  // Update company name if provided
  if (company_name && companyId) {
    await supabaseAdmin
      .from('companies')
      .update({ name: company_name })
      .eq('id', companyId);
  }

  // Fetch and return updated profile
  const { data, error } = await supabaseAdmin
    .from('users')
    .select('id, email, full_name, role, company_id, created_at, company:companies(id, name)')
    .eq('id', userId)
    .single();

  if (error) {
    return c.json({ error: { message: error.message, code: 'DB_ERROR' } }, 500);
  }

  return c.json({ data });
});
