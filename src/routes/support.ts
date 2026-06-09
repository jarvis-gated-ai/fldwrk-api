import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import crypto from 'node:crypto';
import Anthropic from '@anthropic-ai/sdk';
import { supabaseAdmin } from '../lib/supabase';
import { authMiddleware, AuthVariables } from '../middleware/auth';

// ─── Constants ────────────────────────────────

const SLACK_OPS_CHANNEL_ID = process.env.SLACK_OPS_CHANNEL_ID ?? 'C0AU7LY5890';

// ─── Anthropic Client ─────────────────────────

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ─── Router ───────────────────────────────────

export const supportRouter = new Hono<{ Variables: AuthVariables }>();

// ─── Validation Schemas ───────────────────────

const createCaseSchema = z.object({
  subject:     z.string().min(1).max(255),
  description: z.string().min(1),
});

const analyticsQuerySchema = z.object({
  period: z.enum(['7d', '30d', '90d']).default('30d'),
});

// ─── Internal Types ───────────────────────────

interface TriageResult {
  category:                 string;
  sub_category:             string;
  priority:                 string;
  confidence:               number;
  can_auto_resolve:         boolean;
  auto_resolution_message:  string | null;
  requires_escalation:      boolean;
  escalation_reason:        string | null;
}

interface UserContext {
  email:       string;
  fullName:    string;
  role:        string;
  createdAt:   string;
  companyName: string;
  planTier:    string;
}

interface SlackInteractivePayload {
  type: string;
  actions?: Array<{
    type:       string;
    action_id:  string;
    value:      string;
    block_id?:  string;
  }>;
  user?: {
    id:        string;
    username?: string;
    name?:     string;
  };
  channel?: {
    id:    string;
    name?: string;
  };
  message?: {
    ts:      string;
    blocks?: unknown[];
  };
  response_url?: string;
}

// ─── Helper: Post escalation to Slack ────────

async function postEscalationToSlack(params: {
  caseId:           string;
  subject:          string;
  description:      string;
  priority:         string;
  category:         string;
  subCategory:      string;
  fullName:         string;
  email:            string;
  planTier:         string;
  createdAt:        string;
  confidence:       number;
  escalationReason: string;
}): Promise<string | null> {
  const botToken = process.env.SLACK_BOT_TOKEN;
  if (!botToken) {
    console.warn('[Support] SLACK_BOT_TOKEN not set — skipping Slack escalation');
    return null;
  }

  const confidencePct = Math.round(params.confidence * 100);

  const blocks = [
    {
      type: 'header',
      text: { type: 'plain_text', text: '🚨 FLDWRK Support Case — Escalated' },
    },
    {
      type: 'section',
      fields: [
        { type: 'mrkdwn', text: `*Case ID:*\n\`${params.caseId}\`` },
        { type: 'mrkdwn', text: `*Priority:*\n${params.priority}` },
        { type: 'mrkdwn', text: `*Category:*\n${params.category} / ${params.subCategory}` },
        { type: 'mrkdwn', text: `*User:*\n${params.fullName} (${params.email})` },
        { type: 'mrkdwn', text: `*Subscription Tier:*\n${params.planTier}` },
        { type: 'mrkdwn', text: `*Account Since:*\n${params.createdAt}` },
      ],
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*Subject:* ${params.subject}\n*Description:*\n${params.description}`,
      },
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*AI Confidence:* ${confidencePct}% | *AI Reason:* ${params.escalationReason}`,
      },
    },
    {
      type: 'actions',
      elements: [
        {
          type:      'button',
          text:      { type: 'plain_text', text: '✅ Resolve Case' },
          style:     'primary',
          action_id: 'resolve_case',
          value:     params.caseId,
        },
        {
          type:      'button',
          text:      { type: 'plain_text', text: '📝 Add Note' },
          action_id: 'add_note',
          value:     params.caseId,
        },
      ],
    },
  ];

  try {
    const res = await fetch('https://slack.com/api/chat.postMessage', {
      method: 'POST',
      headers: {
        'Content-Type':  'application/json; charset=utf-8',
        'Authorization': `Bearer ${botToken}`,
      },
      body: JSON.stringify({ channel: SLACK_OPS_CHANNEL_ID, blocks }),
    });

    const json = (await res.json()) as { ok: boolean; ts?: string; error?: string };
    if (!json.ok) {
      console.error('[Support] Slack postMessage error:', json.error);
      return null;
    }
    return json.ts ?? null;
  } catch (err) {
    console.error('[Support] Slack postMessage threw:', err);
    return null;
  }
}

// ─── Helper: Background AI triage ────────────

async function triageCase(
  caseId:      string,
  subject:     string,
  description: string,
  ctx:         UserContext
): Promise<void> {
  const systemPrompt = `You are a support triage AI for FLDWRK, a field service management app for trade businesses (plumbers, HVAC, electricians).
Analyze the support case and return JSON only:
{
  "category": "Bug|Billing|Account_Access|Feature_Request|General_Inquiry",
  "sub_category": "brief classification",
  "priority": "Low|Medium|High|Critical",
  "confidence": 0.0-1.0,
  "can_auto_resolve": true|false,
  "auto_resolution_message": "if can_auto_resolve, a helpful response, else null",
  "requires_escalation": true|false,
  "escalation_reason": "reason if requires_escalation, else null"
}
User context: Subscription tier: ${ctx.planTier}, Account since: ${ctx.createdAt}, Company: ${ctx.companyName}`;

  const response = await anthropic.messages.create({
    model:      'claude-sonnet-4-6',
    max_tokens: 1024,
    system:     systemPrompt,
    messages:   [{ role: 'user', content: `Subject: ${subject}\n\nDescription: ${description}` }],
  });

  const block = response.content[0];
  if (block.type !== 'text') throw new Error('Unexpected Anthropic response type');

  // Strip optional markdown code fences before parsing
  const raw    = block.text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  const triage = JSON.parse(raw) as TriageResult;

  const caseUpdate: Record<string, unknown> = {
    category:            triage.category,
    sub_category:        triage.sub_category,
    priority:            triage.priority,
    ai_confidence_score: triage.confidence,
  };

  if (triage.can_auto_resolve && triage.confidence >= 0.85) {
    // ── Auto-resolve ──────────────────────────
    caseUpdate.status      = 'Auto_Resolved';
    caseUpdate.resolved_at = new Date().toISOString();

    await supabaseAdmin.from('support_cases').update(caseUpdate).eq('id', caseId);
    await supabaseAdmin.from('support_interactions').insert({
      case_id:    caseId,
      actor_type: 'ai_response',
      actor_id:   'jarvis-ai',
      content:    triage.auto_resolution_message ?? 'Your issue has been automatically resolved.',
      metadata:   { confidence: triage.confidence, category: triage.category },
    });
  } else if (triage.requires_escalation || triage.confidence < 0.85) {
    // ── Escalate to human ─────────────────────
    caseUpdate.status             = 'Escalated';
    caseUpdate.escalated_to_human = true;

    const slackTs = await postEscalationToSlack({
      caseId,
      subject,
      description,
      priority:         triage.priority,
      category:         triage.category,
      subCategory:      triage.sub_category,
      fullName:         ctx.fullName,
      email:            ctx.email,
      planTier:         ctx.planTier,
      createdAt:        ctx.createdAt,
      confidence:       triage.confidence,
      escalationReason: triage.escalation_reason ?? 'Low AI confidence (< 85%)',
    });

    if (slackTs) caseUpdate.slack_thread_ts = slackTs;

    await supabaseAdmin.from('support_cases').update(caseUpdate).eq('id', caseId);
    await supabaseAdmin.from('support_interactions').insert({
      case_id:    caseId,
      actor_type: 'escalation',
      actor_id:   'jarvis-ai',
      content:    `Case escalated to human support. Reason: ${triage.escalation_reason ?? 'Low AI confidence (< 85%)'}`,
      metadata:   { confidence: triage.confidence, slack_ts: slackTs },
    });
  } else {
    // ── Pending human review ──────────────────
    caseUpdate.status = 'Pending_Review';
    await supabaseAdmin.from('support_cases').update(caseUpdate).eq('id', caseId);
  }
}

// ─── POST /api/v1/support/create ─────────────

supportRouter.post(
  '/create',
  authMiddleware,
  zValidator('json', createCaseSchema),
  async (c) => {
    const { subject, description } = c.req.valid('json');
    const userId    = c.get('userId');
    const companyId = c.get('companyId');

    // Fetch user profile and company in parallel
    const [userRes, companyRes] = await Promise.all([
      supabaseAdmin
        .from('users')
        .select('email, full_name, role, created_at')
        .eq('id', userId)
        .single(),
      supabaseAdmin
        .from('companies')
        .select('name, plan_tier')
        .eq('id', companyId)
        .single(),
    ]);

    const userProfile = userRes.data;
    const company     = companyRes.data;

    // Insert support case
    const { data: newCase, error: caseErr } = await supabaseAdmin
      .from('support_cases')
      .insert({ user_id: userId, company_id: companyId, subject, description })
      .select()
      .single();

    if (caseErr || !newCase) {
      return c.json(
        { error: { message: caseErr?.message ?? 'Failed to create case', code: 'DB_ERROR' } },
        500
      );
    }

    // Log opening user message
    await supabaseAdmin.from('support_interactions').insert({
      case_id:    newCase.id,
      actor_type: 'user_message',
      actor_id:   userId,
      content:    `Subject: ${subject}\n\n${description}`,
    });

    // Fire-and-forget triage — respond immediately with caseId
    const userContext: UserContext = {
      email:       (userProfile?.email       as string)  ?? '',
      fullName:    (userProfile?.full_name   as string)  ?? '',
      role:        (userProfile?.role        as string)  ?? '',
      createdAt:   (userProfile?.created_at  as string)  ?? '',
      companyName: (company?.name            as string)  ?? '',
      planTier:    String(company?.plan_tier ?? 'free'),
    };

    triageCase(newCase.id as string, subject, description, userContext).catch((err) => {
      console.error('[Support] Background triage failed for case', newCase.id, err);
    });

    return c.json({ data: { caseId: newCase.id, status: 'New' } }, 201);
  }
);

// ─── POST /api/v1/support/webhook/interact ────
// Handles Slack interactive button payloads. No auth — protected by signing secret.

supportRouter.post('/webhook/interact', async (c) => {
  // Read raw body once (needed for HMAC verification and payload parsing)
  const rawBody = await c.req.text();

  // Verify Slack signing secret when configured
  const signingSecret = process.env.SLACK_SIGNING_SECRET;
  if (signingSecret) {
    const timestamp = c.req.header('X-Slack-Request-Timestamp');
    const slackSig  = c.req.header('X-Slack-Signature');

    if (!timestamp || !slackSig) {
      return c.json({ error: 'Missing Slack signature headers' }, 400);
    }

    // Reject requests older than 5 minutes (replay attack mitigation)
    if (Math.abs(Date.now() / 1000 - parseInt(timestamp, 10)) > 300) {
      return c.json({ error: 'Request timestamp too old' }, 400);
    }

    const computed = `v0=${crypto
      .createHmac('sha256', signingSecret)
      .update(`v0:${timestamp}:${rawBody}`)
      .digest('hex')}`;

    if (computed !== slackSig) {
      return c.json({ error: 'Invalid Slack signature' }, 401);
    }
  }

  // Slack sends interactive payloads as URL-encoded `payload=<json>`
  const params     = new URLSearchParams(rawBody);
  const payloadStr = params.get('payload') ?? rawBody;

  let payload: SlackInteractivePayload;
  try {
    payload = JSON.parse(payloadStr) as SlackInteractivePayload;
  } catch {
    return c.json({ error: 'Invalid payload JSON' }, 400);
  }

  const action = payload.actions?.[0];
  if (!action) {
    return c.json({ error: 'No action in payload' }, 400);
  }

  const caseId    = action.value;
  const actorId   = payload.user?.id ?? 'unknown';
  const actorName = payload.user?.username ?? payload.user?.name ?? actorId;

  // ── resolve_case ──────────────────────────
  if (action.action_id === 'resolve_case') {
    const { error } = await supabaseAdmin
      .from('support_cases')
      .update({ status: 'Closed', resolved_at: new Date().toISOString() })
      .eq('id', caseId);

    if (error) {
      console.error('[Support] resolve_case DB error:', error.message);
      return c.json({ error: error.message }, 500);
    }

    await supabaseAdmin.from('support_interactions').insert({
      case_id:    caseId,
      actor_type: 'status_change',
      actor_id:   actorId,
      content:    `Case closed by ${actorName} via Slack.`,
      metadata:   { action: 'resolve_case', actor: actorName },
    });

    return c.json({
      replace_original: true,
      blocks: [
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: `✅ *Case \`${caseId}\` resolved* by @${actorName}`,
          },
        },
      ],
    });
  }

  // ── add_note ──────────────────────────────
  if (action.action_id === 'add_note') {
    await supabaseAdmin.from('support_interactions').insert({
      case_id:    caseId,
      actor_type: 'human_note',
      actor_id:   actorId,
      content:    `Note by ${actorName}: ${action.value}`,
      metadata:   { action: 'add_note', actor: actorName },
    });

    return c.json({
      response_type: 'in_channel',
      text: `📝 Note added to case \`${caseId}\` by @${actorName}.`,
    });
  }

  return c.json({ error: `Unknown action_id: ${action.action_id}` }, 400);
});

// ─── Helper: Post reply to an existing Slack thread ─────────

async function postSlackThreadReply(threadTs: string, text: string): Promise<void> {
  const botToken = process.env.SLACK_BOT_TOKEN;
  if (!botToken || !threadTs) return;
  try {
    const res = await fetch('https://slack.com/api/chat.postMessage', {
      method: 'POST',
      headers: {
        'Content-Type':  'application/json; charset=utf-8',
        'Authorization': `Bearer ${botToken}`,
      },
      body: JSON.stringify({ channel: SLACK_OPS_CHANNEL_ID, thread_ts: threadTs, text }),
    });
    const json = (await res.json()) as { ok: boolean; error?: string };
    if (!json.ok) console.error('[Support] patchSlackThread error:', json.error);
  } catch (err) {
    console.error('[Support] patchSlackThread threw:', err);
  }
}

// ─── Admin guard helper ────────────────────────────────────────

const isAdminRole = (role: string): boolean => ['owner', 'admin'].includes(role);

// ─── Validation schemas (admin endpoints) ─────────────────────

const casesQuerySchema = z.object({
  page:       z.coerce.number().int().positive().default(1),
  limit:      z.coerce.number().int().min(1).max(100).default(25),
  status:     z.enum(['All', 'New', 'Auto_Resolved', 'Pending_Review', 'Escalated', 'Closed']).optional(),
  category:   z.enum(['Bug', 'Billing', 'Account_Access', 'Feature_Request', 'General_Inquiry']).optional(),
  search:     z.string().max(200).optional(),
  sort_by:    z.enum(['created_at', 'updated_at', 'priority', 'status']).default('created_at'),
  sort_order: z.enum(['asc', 'desc']).default('desc'),
});

const humanMessageSchema = z.object({
  content:    z.string().min(1).max(10_000),
  close_case: z.boolean().optional().default(false),
});

const caseMetadataSchema = z.object({
  status:   z.enum(['New', 'Auto_Resolved', 'Pending_Review', 'Escalated', 'Closed']).optional(),
  priority: z.enum(['Low', 'Medium', 'High', 'Critical']).optional(),
  category: z.enum(['Bug', 'Billing', 'Account_Access', 'Feature_Request', 'General_Inquiry']).optional(),
}).refine((d) => Object.values(d).some(Boolean), { message: 'At least one field required' });

// ─── GET /api/v1/support/cases (admin) ────────────────────────

supportRouter.get(
  '/cases',
  authMiddleware,
  zValidator('query', casesQuerySchema),
  async (c) => {
    if (!isAdminRole(c.get('userRole'))) {
      return c.json({ error: { message: 'Insufficient permissions', code: 'FORBIDDEN' } }, 403);
    }

    const { page, limit, status, category, search, sort_by, sort_order } = c.req.valid('query');
    const offset = (page - 1) * limit;

    let query = supabaseAdmin
      .from('support_cases')
      .select(
        `id, subject, status, priority, category, sub_category,
         ai_confidence_score, escalated_to_human,
         created_at, updated_at, resolved_at,
         users!inner(id, full_name, email),
         companies!inner(id, name, plan_tier)`,
        { count: 'exact' }
      );

    if (status && status !== 'All') query = query.eq('status', status);
    if (category)                   query = query.eq('category', category);
    if (search) {
      query = query.or(`subject.ilike.%${search}%,description.ilike.%${search}%`);
    }

    query = query
      .order(sort_by as 'created_at', { ascending: sort_order === 'asc' })
      .range(offset, offset + limit - 1);

    const { data, error, count } = await query;

    if (error) {
      return c.json({ error: { message: error.message, code: 'DB_ERROR' } }, 500);
    }

    return c.json({
      data: {
        cases: data ?? [],
        pagination: {
          page,
          limit,
          total: count ?? 0,
          pages: Math.ceil((count ?? 0) / limit),
        },
      },
    });
  }
);

// ─── GET /api/v1/support/cases/:id (admin) ────────────────────

supportRouter.get(
  '/cases/:id',
  authMiddleware,
  async (c) => {
    if (!isAdminRole(c.get('userRole'))) {
      return c.json({ error: { message: 'Insufficient permissions', code: 'FORBIDDEN' } }, 403);
    }

    const caseId = c.req.param('id');

    const [caseRes, interactionsRes] = await Promise.all([
      supabaseAdmin
        .from('support_cases')
        .select(`
          *,
          users!inner(id, full_name, email, role, created_at),
          companies!inner(id, name, plan_tier, created_at)
        `)
        .eq('id', caseId)
        .single(),
      supabaseAdmin
        .from('support_interactions')
        .select('*')
        .eq('case_id', caseId)
        .order('created_at', { ascending: true }),
    ]);

    if (caseRes.error || !caseRes.data) {
      return c.json({ error: { message: 'Case not found', code: 'NOT_FOUND' } }, 404);
    }

    const companyId = (caseRes.data as Record<string, unknown>).company_id as string;
    const { data: subscription } = await supabaseAdmin
      .from('subscriptions')
      .select('plan_tier, status, created_at, current_period_end')
      .eq('company_id', companyId)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    return c.json({
      data: {
        case:         caseRes.data,
        interactions: interactionsRes.data ?? [],
        subscription: subscription ?? null,
      },
    });
  }
);

// ─── POST /api/v1/support/cases/:id/message (admin) ───────────

supportRouter.post(
  '/cases/:id/message',
  authMiddleware,
  zValidator('json', humanMessageSchema),
  async (c) => {
    if (!isAdminRole(c.get('userRole'))) {
      return c.json({ error: { message: 'Insufficient permissions', code: 'FORBIDDEN' } }, 403);
    }

    const caseId = c.req.param('id');
    const { content, close_case } = c.req.valid('json');
    const actorId  = c.get('userId');

    const { data: caseRecord, error: fetchErr } = await supabaseAdmin
      .from('support_cases')
      .select('id, status, slack_thread_ts, user_id, subject, escalated_to_human')
      .eq('id', caseId)
      .single();

    if (fetchErr || !caseRecord) {
      return c.json({ error: { message: 'Case not found', code: 'NOT_FOUND' } }, 404);
    }

    // Agent Takeover: freeze AI, mark human override, set status
    const newStatus = close_case ? 'Closed' : 'Pending_Review';
    const caseUpdate: Record<string, unknown> = {
      escalated_to_human: true,   // AI triage is now frozen for this thread
      status:             newStatus,
      updated_at:         new Date().toISOString(),
    };
    if (close_case) caseUpdate.resolved_at = new Date().toISOString();

    await supabaseAdmin.from('support_cases').update(caseUpdate).eq('id', caseId);

    const { data: interaction } = await supabaseAdmin
      .from('support_interactions')
      .insert({
        case_id:    caseId,
        actor_type: 'human_note',
        actor_id:   actorId,
        content,
        metadata:   { source: 'mission_control', status_set: newStatus },
      })
      .select()
      .single();

    // Bi-directional sync: push update to Slack thread
    const slackTs = caseRecord.slack_thread_ts as string | null;
    if (slackTs) {
      const slackText = close_case
        ? `✅ *Case closed by admin via Mission Control*\n\n${content}`
        : `📝 *Human agent reply via Mission Control:*\n\n${content}`;
      postSlackThreadReply(slackTs, slackText).catch(console.error);
    }

    // TODO: fire Resend email/push notification to end-user

    return c.json({ data: { interaction, status: newStatus } }, 201);
  }
);

// ─── PATCH /api/v1/support/cases/:id/metadata (admin) ─────────

supportRouter.patch(
  '/cases/:id/metadata',
  authMiddleware,
  zValidator('json', caseMetadataSchema),
  async (c) => {
    if (!isAdminRole(c.get('userRole'))) {
      return c.json({ error: { message: 'Insufficient permissions', code: 'FORBIDDEN' } }, 403);
    }

    const caseId  = c.req.param('id');
    const updates = c.req.valid('json');

    const { data: existing, error: fetchErr } = await supabaseAdmin
      .from('support_cases')
      .select('id, slack_thread_ts, status')
      .eq('id', caseId)
      .single();

    if (fetchErr || !existing) {
      return c.json({ error: { message: 'Case not found', code: 'NOT_FOUND' } }, 404);
    }

    const patch: Record<string, unknown> = { ...updates, updated_at: new Date().toISOString() };
    if (updates.status === 'Closed') patch.resolved_at = new Date().toISOString();

    const { data: updatedCase, error } = await supabaseAdmin
      .from('support_cases')
      .update(patch)
      .eq('id', caseId)
      .select()
      .single();

    if (error) {
      return c.json({ error: { message: error.message, code: 'DB_ERROR' } }, 500);
    }

    // Bi-directional sync: patch Slack thread when status changes
    const slackTs = existing.slack_thread_ts as string | null;
    if (updates.status && slackTs) {
      const emoji = updates.status === 'Closed' ? '✅' : '🔄';
      postSlackThreadReply(
        slackTs,
        `${emoji} Case status updated to *${updates.status}* via Mission Control`
      ).catch(console.error);
    }

    return c.json({ data: { case: updatedCase } });
  }
);

// ─── GET /api/v1/support/analytics/summary ────

supportRouter.get(
  '/analytics/summary',
  authMiddleware,
  zValidator('query', analyticsQuerySchema),
  async (c) => {
    const userRole = c.get('userRole');

    if (!['owner', 'admin'].includes(userRole)) {
      return c.json(
        { error: { message: 'Insufficient permissions', code: 'FORBIDDEN' } },
        403
      );
    }

    const { period } = c.req.valid('query');
    const days  = period === '7d' ? 7 : period === '30d' ? 30 : 90;
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

    // Fetch all support cases in the window (supabaseAdmin bypasses RLS for platform-level view)
    const { data: cases, error: casesErr } = await supabaseAdmin
      .from('support_cases')
      .select('id, status, category, created_at, resolved_at, escalated_to_human, company_id')
      .gte('created_at', since)
      .order('created_at', { ascending: true });

    if (casesErr) {
      return c.json({ error: { message: casesErr.message, code: 'DB_ERROR' } }, 500);
    }

    const allCases = cases ?? [];
    const total    = allCases.length;

    // ── Volume over time ──────────────────────
    const volMap = new Map<string, number>();
    for (const sc of allCases) {
      const date = (sc.created_at as string).slice(0, 10);
      volMap.set(date, (volMap.get(date) ?? 0) + 1);
    }
    const volumeOverTime = Array.from(volMap.entries()).map(([date, count]) => ({ date, count }));

    // ── Category distribution ─────────────────
    const catMap = new Map<string, number>();
    for (const sc of allCases) {
      const cat = (sc.category as string | null) ?? 'General_Inquiry';
      catMap.set(cat, (catMap.get(cat) ?? 0) + 1);
    }
    const categoryDistribution = Array.from(catMap.entries()).map(([category, count]) => ({
      category,
      count,
      percentage: total > 0 ? Math.round((count / total) * 1000) / 10 : 0,
    }));

    // ── Subscription breakdown ─────────────────
    const companyIds = [...new Set(allCases.map((sc) => sc.company_id as string))];
    let subscriptionBreakdown: Array<{ tier: string; count: number }> = [];

    if (companyIds.length > 0) {
      const { data: subs } = await supabaseAdmin
        .from('subscriptions')
        .select('company_id, plan_tier')
        .in('company_id', companyIds);

      const tierByCompany = new Map<string, string>();
      for (const s of subs ?? []) {
        tierByCompany.set(s.company_id as string, s.plan_tier as string);
      }

      const tierCount = new Map<string, number>();
      for (const sc of allCases) {
        const tier = tierByCompany.get(sc.company_id as string) ?? 'free';
        tierCount.set(tier, (tierCount.get(tier) ?? 0) + 1);
      }

      subscriptionBreakdown = Array.from(tierCount.entries()).map(([tier, count]) => ({
        tier,
        count,
      }));
    }

    // ── SLA performance ───────────────────────
    type CaseRow = { created_at: string; resolved_at: string | null };

    const computeAvgHours = (subset: CaseRow[]): number => {
      const resolved = subset.filter((sc) => sc.resolved_at);
      if (resolved.length === 0) return 0;
      const totalMs = resolved.reduce((sum, sc) => {
        return (
          sum +
          (new Date(sc.resolved_at as string).getTime() - new Date(sc.created_at).getTime())
        );
      }, 0);
      return Math.round((totalMs / resolved.length / 3_600_000) * 100) / 100;
    };

    const autoResolvedCases = allCases.filter(
      (sc) => (sc.status as string) === 'Auto_Resolved'
    ) as CaseRow[];
    const escalatedResolved = allCases.filter(
      (sc) => sc.escalated_to_human && sc.resolved_at
    ) as CaseRow[];
    const escalatedCount = allCases.filter((sc) => sc.escalated_to_human).length;

    return c.json({
      data: {
        period,
        volume_over_time:       volumeOverTime,
        category_distribution:  categoryDistribution,
        subscription_breakdown: subscriptionBreakdown,
        sla_performance: {
          avg_resolution_hours_auto:      computeAvgHours(autoResolvedCases),
          avg_resolution_hours_escalated: computeAvgHours(escalatedResolved),
          auto_resolved_count:            autoResolvedCases.length,
          escalated_count:                escalatedCount,
        },
        escalation_rate:
          total > 0 ? Math.round((escalatedCount / total) * 1000) / 1000 : 0,
      },
    });
  }
);
