import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const supabaseAnonKey = process.env.SUPABASE_ANON_KEY;

if (!supabaseUrl) throw new Error('Missing env: SUPABASE_URL');
if (!supabaseServiceKey) throw new Error('Missing env: SUPABASE_SERVICE_ROLE_KEY');
if (!supabaseAnonKey) throw new Error('Missing env: SUPABASE_ANON_KEY');

// Admin client — bypasses RLS, for server-side operations
export const supabaseAdmin = createClient(supabaseUrl, supabaseServiceKey, {
  auth: {
    autoRefreshToken: false,
    persistSession: false,
  },
});

/** Returns true when Supabase reports a table/schema doesn't exist yet. */
export function isSchemaError(error: { code?: string; message?: string } | null): boolean {
  if (!error) return false;
  return (
    error.code === 'PGRST205' ||
    error.code === 'PGRST200' ||
    (typeof error.message === 'string' && error.message.includes('schema cache'))
  );
}

// Creates a user-scoped client using the request's JWT
// RLS will enforce company-level isolation
export function createUserClient(jwt: string) {
  return createClient(supabaseUrl!, supabaseAnonKey!, {
    global: {
      headers: {
        Authorization: `Bearer ${jwt}`,
      },
    },
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  });
}
