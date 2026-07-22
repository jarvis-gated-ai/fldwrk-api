import { Hono } from 'hono';
import OpenAI from 'openai';
import { authMiddleware, AuthVariables } from '../middleware/auth';
import { createUserClient, supabaseAdmin } from '../lib/supabase';

export const voiceRouter = new Hono<{ Variables: AuthVariables }>();

voiceRouter.use('*', authMiddleware);

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const STORAGE_BUCKET = process.env.SUPABASE_STORAGE_BUCKET ?? 'voice-recordings';

// ─── Structured extraction types ─────────────────────────────────────────────

interface VoiceLogAction {
  type:
    | 'create_customer' | 'create_job'  | 'create_quote'
    | 'update_job'     | 'update_customer' | 'update_quote';
  confidence: number;
  data: Record<string, unknown>;
}

interface LineItem {
  description: string;
  quantity:    number;
  unit_price:  number;  // dollars
  line_total:  number;  // dollars
}

interface JobNotes {
  summary:        string | null;
  work_performed: string | null;
  materials_used: string | null;
  issues_found:   string | null;
  follow_ups:     string | null;
}

interface ExtractedResult {
  summary:   string;
  actions:   VoiceLogAction[];
  job_notes: JobNotes | null;
}

// Whisper trade vocabulary — seeds the transcription model with common trade terms.
// P2-6c model eval (2026-07-21):
//   gpt-4o-transcribe: ~$0.006/min, reported better accuracy on domain-specific terms
//   whisper-1:         ~$0.006/min, identical pricing, well-tested production model
//   VERDICT: Keep whisper-1 for now — same cost, proven stable. Re-evaluate when
//     gpt-4o-transcribe exits beta and has documented WER benchmarks.
const WHISPER_TRADE_PROMPT = [
  'quote, line item, invoice, labor, materials, HVAC, ductwork, drywall, plumbing, piping,',
  'permit, conduit, breaker, valve, compressor, thermostat, drain, slab, flashing, sheetrock,',
  'Romex, PEX, CPVC, ABS, PVC, trap, P-trap, wax ring, shutoff valve, expansion tank,',
  'heat pump, mini-split, BTU, tonnage, squareness, fascia, soffit, siding, joist, rafter,',
  'furring strip, fire blocking, smoke detector, GFCI, arc fault, panel, subpanel, disconnect,',
  'load center, busbar, neutral, ground fault, junction box, rough-in, trim-out, punch list,',
  'scope of work, change order, T&M, time and materials',
].join(' ');

const EXTRACTION_SYSTEM_PROMPT = `You are an AI assistant for a field service management app used by tradespeople (plumbers, electricians, HVAC techs, etc.).

Extract structured actions AND job notes from the transcript. Return ONLY valid JSON in this exact shape:
{
  "summary": "Brief 2-3 sentence summary of what was discussed",
  "job_notes": {
    "summary":        "1-2 sentence summary of work done on this visit, or null",
    "work_performed": "What work was actually done, or null",
    "materials_used": "Parts and materials mentioned, or null",
    "issues_found":   "Problems discovered on-site, or null",
    "follow_ups":     "What still needs to be done or checked, or null"
  },
  "actions": [
    {
      "type": "create_customer",
      "confidence": 0.95,
      "data": {
        "name": "Full Name",
        "phone": "phone number or null",
        "email": "email or null",
        "address": "full address or null",
        "notes": "any other relevant info or null"
      }
    },
    {
      "type": "create_job",
      "confidence": 0.90,
      "data": {
        "title": "job title",
        "description": "detailed description",
        "status": "pending",
        "scheduled_date": "ISO date string or null",
        "customer_name": "name if mentioned, to link to created customer"
      }
    },
    {
      "type": "create_quote",
      "confidence": 0.85,
      "data": {
        "title": "quote title",
        "description": "what the quote is for",
        "customer_name": "name if mentioned",
        "job_title": "job title if mentioned, to link to created job",
        "line_items": [
          { "description": "Labor", "quantity": 1, "unit_price": 7000.00, "line_total": 7000.00 },
          { "description": "Materials", "quantity": 1, "unit_price": 3500.00, "line_total": 3500.00 }
        ]
      }
    },
    {
      "type": "update_job",
      "confidence": 0.90,
      "data": {
        "job_title": "title of the existing job to find and update",
        "new_status": "completed | in_progress | pending | scheduled | cancelled (omit if not changing)",
        "title": "new title if renaming the job (omit if not renaming)",
        "notes": "updated notes to add or replace (omit if not changing)",
        "customer_name": "new customer name if reassigning (omit if not changing)"
      }
    },
    {
      "type": "update_customer",
      "confidence": 0.88,
      "data": {
        "customer_name": "existing customer name to find",
        "name": "new name if renaming (omit if not changing)",
        "phone": "new phone number (omit if not changing)",
        "email": "new email (omit if not changing)",
        "address": "new address (omit if not changing)"
      }
    },
    {
      "type": "update_quote",
      "confidence": 0.85,
      "data": {
        "job_title": "title of the job this quote belongs to (to find the quote)",
        "new_status": "accepted | rejected | sent | draft | expired (omit if not changing)",
        "amount": 12500.00
      }
    }
  ]
}

RULES:
- Use create_ actions for NEW records, update_ actions for EXISTING records.
- Keywords like 'mark', 'update', 'change', 'set', 'complete', 'finish', 'close', 'cancel' → update_ action.
- Keywords like 'new', 'add', 'create', 'log' → create_ action.
- Only include actions clearly requested or strongly implied. Confidence >= 0.7 required.
- Never invent data not in the transcript.
- Omit any action type that does not apply.
- CRITICAL — EXPLICIT ENTITY CREATION: If the user explicitly says "create a job" or "add a job" or "log a job", you MUST include a create_job action. Never silently drop explicitly requested entities. If you cannot determine a job title, use the service description as the title.
- For create_quote: ALWAYS return line_items as an array. No top-level "amount" field. Total = sum of line_items[*].line_total.
- CRITICAL — UNIQUE LINE ITEMS: Each line item must describe a DISTINCT service or material. Do NOT repeat the same description multiple times. If a single price is mentioned with no breakdown, produce exactly ONE line item (e.g. { "description": "Swimming Pool Service", "quantity": 1, "unit_price": X, "line_total": X }). Maximum 10 unique line items per quote.
- CRITICAL — dollar amounts in quotes: when the user states a total price (e.g. "quote it at two thousand dollars", "charge $450", "the job is $2,000"), that dollar amount MUST go into unit_price and line_total of a line item — NEVER into the description string. Example: "quote it at two thousand dollars" → line_items: [{ "description": "Service", "quantity": 1, "unit_price": 2000.00, "line_total": 2000.00 }]. If the service type is mentioned (e.g. "AC repair for $450"), use that as the description instead of generic "Service".
- Normalize obvious mis-hears: "two lighten items" → "two line items".
- job_notes: populate if ANY work-related content exists. Set fields to null only if genuinely absent.`;

// P2-6b: Normalize obvious speech-to-text mis-hears in trade/construction context.
// Called after Whisper transcription and before GPT-4o action extraction.
// Uses gpt-4o-mini at temperature=0 for deterministic, low-cost corrections.
async function normalizeTranscript(raw: string): Promise<string> {
  try {
    const resp = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      temperature: 0,
      messages: [
        {
          role: 'system',
          content:
            'You are a field service transcript normalizer. Fix obvious speech-to-text mis-hears in trade/construction context. Common corrections: \'romex\' (not \'rome x\'), \'PEX\' (not \'pex\'), \'GFCI\' (not \'G-F-C-I\'), \'HVAC\' (not \'H-VAC\'), etc. Return ONLY the corrected transcript, no explanations, no changes beyond obvious mis-hears.',
        },
        { role: 'user', content: raw },
      ],
    });
    return resp.choices[0]?.message?.content ?? raw;
  } catch {
    return raw; // fallback to raw on error
  }
}

async function extractActionsFromTranscript(transcript: string): Promise<ExtractedResult> {
  const response = await openai.chat.completions.create({
    model: 'gpt-4o',
    messages: [
      { role: 'system', content: EXTRACTION_SYSTEM_PROMPT },
      { role: 'user', content: `Voice note transcript:\n\n${transcript}` },
    ],
    max_tokens: 1200,
    temperature: 0.2,
    response_format: { type: 'json_object' },
  });

  const content = response.choices[0]?.message?.content ?? '{}';
  const parsed = JSON.parse(content) as Partial<ExtractedResult>;

  const summary = parsed.summary ?? '';
  const VALID_TYPES = new Set([
    'create_customer', 'create_job', 'create_quote',
    'update_job', 'update_customer', 'update_quote',
  ]);
  const actions = (parsed.actions ?? []).filter(
    (a): a is VoiceLogAction =>
      typeof a === 'object' &&
      a !== null &&
      VALID_TYPES.has(a.type) &&
      typeof a.confidence === 'number' &&
      a.confidence >= 0.7
  );

  const rawNotes = parsed.job_notes;
  const job_notes: JobNotes | null = rawNotes && typeof rawNotes === 'object'
    ? {
        summary:        rawNotes.summary        ?? null,
        work_performed: rawNotes.work_performed ?? null,
        materials_used: rawNotes.materials_used ?? null,
        issues_found:   rawNotes.issues_found   ?? null,
        follow_ups:     rawNotes.follow_ups     ?? null,
      }
    : null;

  // ─── Post-processing: deduplicate line items in create_quote actions ─────────────────
  for (const action of actions) {
    if (action.type === 'create_quote' && Array.isArray(action.data.line_items)) {
      const rawItems = action.data.line_items as LineItem[];
      const seen = new Set<string>();
      const deduped: LineItem[] = [];
      for (const item of rawItems) {
        const key = `${item.description?.toLowerCase().trim()}|${item.unit_price}|${item.quantity}`;
        if (!seen.has(key)) {
          seen.add(key);
          deduped.push(item);
        } else {
          console.warn(`[Voice] Deduplicated repeated line item: "${item.description}"`);
        }
      }
      action.data.line_items = deduped;
    }
  }

  // ─── Validation: log dropped or missing entities ──────────────────────────────────
  const hasJob    = actions.some(a => a.type === 'create_job' || a.type === 'update_job');
  const hasQuote  = actions.some(a => a.type === 'create_quote' || a.type === 'update_quote');

  // Check: if a quote references a job_title not present in create_job actions, warn
  for (const action of actions) {
    if (action.type === 'create_quote') {
      const refJobTitle = (action.data.job_title as string | undefined)?.toLowerCase().trim();
      if (refJobTitle) {
        const jobExists = actions.some(
          a => a.type === 'create_job' &&
            typeof a.data.title === 'string' &&
            a.data.title.toLowerCase().trim() === refJobTitle
        );
        if (!jobExists) {
          console.warn(
            `[Voice] Quote "${action.data.title}" references job_title "${action.data.job_title}" ` +
            `but no create_job action found for that title. User will be prompted to link manually.`
          );
        }
      }
    }
  }

  if (actions.length === 0) {
    console.warn('[Voice] GPT returned 0 actions from transcript. Raw response was:', content);
  } else {
    console.log(`[Voice] Extracted ${actions.length} action(s):`, actions.map(a => `${a.type}(confidence=${a.confidence})`).join(', '));
    if (!hasJob && hasQuote) {
      console.warn('[Voice] WARNING: Quote action present but no job action found. Check if a job was explicitly requested and silently dropped.');
    }
  }

  return { summary, actions, job_notes };
}

// ─── POST /api/v1/voice/transcribe ────────────────────────────────────────────
// Accepts multipart/form-data with:
//   - audio:          audio file (mp4, m4a, wav, mp3, webm)
//   - job_id:         UUID of the associated job (optional)
//   - linked_to_type: 'job' | 'customer' | 'quote' (optional, for polymorphic link)
//   - linked_to_id:   UUID of the linked record (optional)

voiceRouter.post('/transcribe', async (c) => {
  const userId = c.get('userId');
  const jwt = c.get('jwt');
  const supabase = createUserClient(jwt);

  let formData: FormData;
  try {
    formData = await c.req.formData();
  } catch {
    return c.json(
      { error: { message: 'Request must be multipart/form-data', code: 'INVALID_REQUEST' } },
      400
    );
  }

  const jobId            = (formData.get('job_id') as string | null) || null;
  const linkedToType     = (formData.get('linked_to_type') as string | null) || null;
  const linkedToId       = (formData.get('linked_to_id') as string | null) || null;
  const audioFile        = formData.get('audio') as File | null;

  if (!audioFile) {
    return c.json({ error: { message: 'audio file is required', code: 'VALIDATION_ERROR' } }, 400);
  }

  // Validate job ownership if job_id provided
  if (jobId) {
    const { data: job, error: jobError } = await supabase
      .from('jobs')
      .select('id')
      .eq('id', jobId)
      .single();

    if (jobError || !job) {
      return c.json({ error: { message: 'Job not found or access denied', code: 'NOT_FOUND' } }, 404);
    }
  }

  // ── 1. Upload audio to Supabase Storage ──────────────────────────────────

  const audioBuffer  = await audioFile.arrayBuffer();
  const audioBytes   = new Uint8Array(audioBuffer);
  const fileExt      = audioFile.name.split('.').pop() ?? 'mp4';
  const storagePath  = `${userId}/${jobId ?? linkedToId ?? 'unlinked'}/${Date.now()}.${fileExt}`;

  // Normalize iOS MIME quirks: audio/x-m4a, audio/m4a → canonical audio/mp4
  const rawType    = audioFile.type || '';
  const contentType = /m4a|aac|mp4/i.test(rawType) ? 'audio/mp4' : rawType || 'audio/mp4';
  console.log(`[voice/transcribe] audioFile.type='${audioFile.type}' → contentType='${contentType}'`);

  const { error: uploadError } = await supabaseAdmin.storage
    .from(STORAGE_BUCKET)
    .upload(storagePath, audioBytes, {
      contentType,
      upsert: false,
    });

  if (uploadError) {
    console.error('[voice/transcribe] Supabase storage upload failed:', JSON.stringify(uploadError));
    return c.json({ error: { message: 'Storage upload failed: ' + (uploadError.message || 'unknown') } }, 500);
  }

  const { data: publicUrlData } = supabaseAdmin.storage
    .from(STORAGE_BUCKET)
    .getPublicUrl(storagePath);

  const audioUrl = publicUrlData?.publicUrl ?? null;

  // ── 2. Transcribe with Whisper ────────────────────────────────────────────

  let transcript = '';
  try {
    const openaiFile = new File([audioBytes], `recording.${fileExt}`, { type: contentType });
    const transcriptionResponse = await openai.audio.transcriptions.create({
      file:            openaiFile,
      model:           'whisper-1',
      language:        'en',
      response_format: 'text',
      prompt:          WHISPER_TRADE_PROMPT,
    });
    transcript = typeof transcriptionResponse === 'string'
      ? transcriptionResponse
      : (transcriptionResponse as { text: string }).text;
  } catch (err) {
    console.error('[Voice] Whisper transcription error:', err);
    return c.json(
      { error: { message: 'Transcription failed', code: 'TRANSCRIPTION_ERROR' } },
      500
    );
  }

  // P2-6b: Normalize obvious mis-hears before GPT-4o extraction
  transcript = await normalizeTranscript(transcript);

  // ── 3. Structured extraction with GPT-4o ─────────────────────────────────

  let summary  = '';
  let actions: VoiceLogAction[] = [];
  let jobNotes: JobNotes | null = null;
  try {
    const extracted = await extractActionsFromTranscript(transcript);
    summary  = extracted.summary;
    actions  = extracted.actions;
    jobNotes = extracted.job_notes;
  } catch (err) {
    console.error('[Voice] GPT-4o extraction error:', err);
    // Non-fatal — still return transcript without actions
  }

  // ── 4. Persist voice log ──────────────────────────────────────────────────
  // Attempts to save regardless of whether job_id is present (requires migration
  // 003_voice_logs_polymorphic to have been applied for job_id=null rows).
  // Falls back gracefully if NOT NULL constraint is still active.

  let voiceLogId: string | null = null;

  const insertPayload: Record<string, unknown> = {
    user_id:       userId,
    audio_url:     audioUrl,
    transcript,
    summary,
  };

  // Set job_id if provided (backward compat + FK link)
  if (jobId) {
    insertPayload.job_id = jobId;
    insertPayload.linked_to_type = 'job';
    insertPayload.linked_to_id   = jobId;
  } else if (linkedToType && linkedToId) {
    // Polymorphic link (post-migration): no job_id, just linked_to_* columns
    insertPayload.linked_to_type = linkedToType;
    insertPayload.linked_to_id   = linkedToId;
  }

  try {
    const { data: voiceLog, error: dbError } = await supabaseAdmin
      .from('voice_logs')
      .insert(insertPayload)
      .select('id')
      .single();

    if (dbError) {
      // If migration hasn't been applied and job_id is null, this will fail with
      // a NOT NULL violation — that's acceptable, transcript is still returned.
      console.error('[Voice] DB insert error:', dbError.message);
    } else {
      voiceLogId = voiceLog?.id ?? null;
    }
  } catch (err) {
    console.error('[Voice] Unexpected DB error:', err);
  }

  // ── 5. Persist job_notes (non-fatal) — requires migration 004 ─────────────
  if (jobId && voiceLogId && jobNotes) {
    const anyContent = Object.values(jobNotes).some((v) => v !== null);
    if (anyContent) {
      const { data: userData } = await supabaseAdmin
        .from('users')
        .select('company_id')
        .eq('id', userId)
        .single();
      if (userData?.company_id) {
        await supabaseAdmin.from('job_notes').insert({
          job_id:         jobId,
          voice_log_id:   voiceLogId,
          user_id:        userId,
          company_id:     userData.company_id,
          summary:        jobNotes.summary,
          work_performed: jobNotes.work_performed,
          materials_used: jobNotes.materials_used,
          issues_found:   jobNotes.issues_found,
          follow_ups:     jobNotes.follow_ups,
        }).then(({ error }) => {
          if (error) console.warn('[Voice] job_notes insert failed (migration 004 needed?):', error.message);
        });
      }
    }
  }

  return c.json(
    {
      data: {
        voice_log_id: voiceLogId,
        transcript,
        summary,
        job_id:    jobId,
        audio_url: audioUrl,
        actions,
        job_notes: jobNotes,
      },
    },
    201
  );
});

// ─── PATCH /api/v1/voice/:id/links ───────────────────────────────────────────
// Update a voice log's polymorphic link and record of created records.

voiceRouter.patch('/:id/links', async (c) => {
  const voiceLogId = c.req.param('id');
  const userId     = c.get('userId');

  let body: {
    linked_to_type?: string | null;
    linked_to_id?:   string | null;
    actions_created?: unknown[];
  };

  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: { message: 'Invalid JSON body', code: 'INVALID_REQUEST' } }, 400);
  }

  const { data, error } = await supabaseAdmin
    .from('voice_logs')
    .update({
      linked_to_type:   body.linked_to_type ?? null,
      linked_to_id:     body.linked_to_id ?? null,
      actions_created:  body.actions_created ?? [],
    })
    .eq('id', voiceLogId)
    .eq('user_id', userId)   // enforce ownership
    .select('id')
    .single();

  if (error || !data) {
    return c.json({ error: { message: 'Voice log not found or update failed', code: 'NOT_FOUND' } }, 404);
  }

  return c.json({ data: { id: voiceLogId } });
});

// ─── GET /api/v1/voice/:job_id ───────────────────────────────────────────────
// Fetch all voice logs for a given job.

voiceRouter.get('/:job_id', async (c) => {
  const jobId  = c.req.param('job_id');
  const jwt    = c.get('jwt');
  const supabase = createUserClient(jwt);

  const { data, error } = await supabase
    .from('voice_logs')
    .select('*')
    .eq('job_id', jobId)
    .order('created_at', { ascending: false });

  if (error) {
    return c.json({ error: { message: error.message, code: 'DB_ERROR' } }, 500);
  }

  return c.json({ data });
});
