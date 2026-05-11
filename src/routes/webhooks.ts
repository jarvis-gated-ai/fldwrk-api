import { Hono } from 'hono';
import { supabaseAdmin } from '../lib/supabase';

export const webhooksRouter = new Hono();

// ─── RevenueCat Webhook Types ─────────────────────────────────────────────────
interface RCSubscriberAttributes {
  $email?: { value: string };
}

interface RCEvent {
  type: string;
  app_user_id: string;
  aliases?: string[];
  subscriber_attributes?: RCSubscriberAttributes;
  product_id?: string;
  entitlement_ids?: string[];
  period_type?: string;           // 'NORMAL' | 'TRIAL' | 'INTRO'
  purchased_at_ms?: number;
  expiration_at_ms?: number;
  auto_resume_at_ms?: number;
  store?: string;                 // 'APP_STORE' | 'PLAY_STORE' | 'STRIPE'
  environment?: string;           // 'SANDBOX' | 'PRODUCTION'
}

interface RCPayload {
  event: RCEvent;
  api_version: string;
}

// Map RC entitlement → plan tier
const ENTITLEMENT_TO_TIER: Record<string, string> = {
  solo_access:  'solo',
  crew_access:  'crew',
  shop_access:  'shop',
  pro_access:   'crew', // fallback
};

// Map RC event types → subscription status
const RC_STATUS_MAP: Record<string, string> = {
  INITIAL_PURCHASE:          'active',
  RENEWAL:                   'active',
  PRODUCT_CHANGE:            'active',
  UNCANCELLATION:            'active',
  CANCELLATION:              'canceled',
  EXPIRATION:                'expired',
  BILLING_ISSUE:             'past_due',
  SUBSCRIBER_ALIAS:          'active',
  TRANSFER:                  'active',
  SUBSCRIPTION_PAUSED:       'paused',
  AUTO_RENEW_STATUS_CHANGE:  'active',
};

// ─── POST /api/v1/webhooks/revenuecat ─────────────────────────────────────────
webhooksRouter.post('/revenuecat', async (c) => {
  // Verify shared secret header
  const secret = process.env.REVENUECAT_WEBHOOK_SECRET;
  if (secret) {
    const authHeader = c.req.header('Authorization');
    if (authHeader !== secret) {
      return c.json({ error: 'Unauthorized' }, 401);
    }
  }

  let payload: RCPayload;
  try {
    payload = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON' }, 400);
  }

  const { event } = payload;
  if (!event?.type || !event?.app_user_id) {
    return c.json({ error: 'Missing event fields' }, 400);
  }

  console.log(`[RC Webhook] ${event.type} for user: ${event.app_user_id}`);

  // Determine subscription status
  const status = RC_STATUS_MAP[event.type];
  if (!status) {
    // Unhandled event type — acknowledge and ignore
    return c.json({ received: true });
  }

  // Determine plan tier from entitlements
  const entitlement  = event.entitlement_ids?.[0] ?? '';
  const tier         = ENTITLEMENT_TO_TIER[entitlement] ?? 'solo';

  // Convert RC user ID → Supabase user ID
  // RC app_user_id is set to the Supabase auth UUID at login
  const userId = event.app_user_id;

  // Fetch the user's company_id
  const { data: user, error: userErr } = await supabaseAdmin
    .from('users')
    .select('company_id')
    .eq('id', userId)
    .single();

  if (userErr || !user) {
    // User not found — could be sandbox/test event, acknowledge gracefully
    console.warn(`[RC Webhook] User not found: ${userId}`);
    return c.json({ received: true });
  }

  const expiresAt = event.expiration_at_ms
    ? new Date(event.expiration_at_ms).toISOString()
    : null;

  // Upsert subscription record
  const { error: upsertErr } = await supabaseAdmin
    .from('subscriptions')
    .upsert(
      {
        company_id:               user.company_id,
        revenuecat_customer_id:   userId,
        plan_tier:                tier,
        status,
        current_period_end:       expiresAt,
        // Keep stripe_subscription_id if it was set previously (don't overwrite)
      },
      {
        onConflict:     'company_id',
        ignoreDuplicates: false,
      },
    );

  if (upsertErr) {
    console.error('[RC Webhook] Upsert error:', upsertErr.message);
    return c.json({ error: upsertErr.message }, 500);
  }

  return c.json({ received: true });
});
