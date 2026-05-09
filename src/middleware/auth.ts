import { createMiddleware } from 'hono/factory';
import { supabaseAdmin } from '../lib/supabase';

export type AuthVariables = {
  userId: string;
  companyId: string;
  userRole: string;
  jwt: string;
};

/**
 * Supabase JWT verification middleware.
 * Extracts user context from the Bearer token and sets
 * userId, companyId, userRole, and jwt on the Hono context.
 */
export const authMiddleware = createMiddleware<{ Variables: AuthVariables }>(async (c, next) => {
  const authHeader = c.req.header('Authorization');

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return c.json(
      { error: { message: 'Missing or invalid Authorization header', code: 'UNAUTHORIZED' } },
      401
    );
  }

  const jwt = authHeader.replace('Bearer ', '').trim();

  // Verify the JWT with Supabase
  const {
    data: { user },
    error: authError,
  } = await supabaseAdmin.auth.getUser(jwt);

  if (authError || !user) {
    return c.json(
      { error: { message: 'Invalid or expired token', code: 'UNAUTHORIZED' } },
      401
    );
  }

  // Fetch the user's company and role from our users table
  const { data: userRecord, error: userError } = await supabaseAdmin
    .from('users')
    .select('id, company_id, role')
    .eq('id', user.id)
    .single();

  if (userError || !userRecord) {
    // Auto-provision: user is authenticated but has no profile yet.
    // This happens when a user is created directly in Supabase Auth
    // without going through the /register API endpoint.
    const companyName = (user.user_metadata?.company_name as string | undefined)
      || (user.email ? `${user.email.split('@')[0].replace(/[^a-zA-Z0-9 ]/g, ' ').trim()}'s Company` : 'My Company');

    const { data: newCompany, error: companyErr } = await supabaseAdmin
      .from('companies')
      .insert({ name: companyName })
      .select()
      .single();

    if (companyErr || !newCompany) {
      return c.json(
        { error: { message: 'Failed to provision company', code: 'PROVISION_ERROR' } },
        500
      );
    }

    const fullName = (user.user_metadata?.full_name as string | undefined)
      || (user.email ? user.email.split('@')[0] : 'User');

    const { error: insertErr } = await supabaseAdmin
      .from('users')
      .insert({
        id:         user.id,
        email:      user.email ?? '',
        full_name:  fullName,
        company_id: newCompany.id,
        role:       'owner',
      });

    if (insertErr) {
      // Clean up orphaned company
      await supabaseAdmin.from('companies').delete().eq('id', newCompany.id);
      return c.json(
        { error: { message: 'Failed to provision user profile', code: 'PROVISION_ERROR' } },
        500
      );
    }

    c.set('userId',    user.id);
    c.set('companyId', newCompany.id);
    c.set('userRole',  'owner');
    c.set('jwt',       jwt);
    await next();
    return;
  }

  // Attach context for downstream handlers
  c.set('userId', user.id);
  c.set('companyId', userRecord.company_id);
  c.set('userRole', userRecord.role);
  c.set('jwt', jwt);

  await next();
});
