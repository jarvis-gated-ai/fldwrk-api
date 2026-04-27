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
    return c.json(
      {
        error: {
          message: 'User profile not found. Ensure the user is provisioned in the users table.',
          code: 'USER_NOT_FOUND',
        },
      },
      403
    );
  }

  // Attach context for downstream handlers
  c.set('userId', user.id);
  c.set('companyId', userRecord.company_id);
  c.set('userRole', userRecord.role);
  c.set('jwt', jwt);

  await next();
});
