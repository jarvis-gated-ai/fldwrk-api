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
  type: 'create_customer' | 'create_job' | 'create_quote';
  confidence: number;
  data: Record<string, unknown>;
}

interface ExtractedResult {
  summary: string;
  actions: VoiceLogAction[];
}

const EXTRACTION_SYSTEM_PROMPT = `You are an AI assistant for a field service management app used by tradespeople (plumbers, electricians, HVAC techs, etc.).

Extract structured actions from the transcript. Return ONLY valid JSON in this exact shape:
{
  "summary": "Brief 2-3 sentence summary of what was discussed",
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
        "priority": "normal",
        "scheduled_date": "ISO date string or null",
        "estimated_duration_hours": null,
        "customer_name": "name if mentioned, to link to created customer"
      }
    },
    {
      "type": "create_quote",
      "confidence": 0.85,
      "data": {
        "title": "quote title",
        "amount": null,
        "description": "what the quote is for",
        "line_items": [
          { "description": "item", "amount": 0, "quantity": 1 }
        ],
        "customer_name": "name if mentioned",
        "job_title": "job title if mentioned, to link to created job"
      }
    }
  ]
}

Only include actions that are clearly requested or strongly implied. If no actions are detected, return an empty actions array. Never invent data not present in the transcript. Confidence should reflect how certain you are the user wants this action taken. Only include action types that are relevant (omit shapes that don't apply).`;

async function extractActionsFromTranscript(transcript: string): Promise<ExtractedResult> {
  const response = await openai.chat.completions.create({
    model: 'gpt-4o',
    messages: [
      { role: 'system', content: EXTRACTION_SYSTEM_PROMPT },
      { role: 'user', content: `Voice note transcript:\n\n${transcript}` },
    ],
    max_tokens: 600,
    temperature: 0.2,
    response_format: { type: 'json_object' },
  });

  const content = response.choices[0]?.message?.content ?? '{}';
  const parsed = JSON.parse(content) as Partial<ExtractedResult>;

  const summary = parsed.summary ?? '';
  const actions = (parsed.actions ?? []).filter(
    (a): a is VoiceLogAction =>
      typeof a === 'object' &&
      a !== null &&
      typeof a.confidence === 'number' &&
      a.confidence >= 0.7
  );

  return { summary, actions };
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
      file: openaiFile,
      model: 'whisper-1',
      language: 'en',
      response_format: 'text',
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

  // ── 3. Structured extraction with GPT-4o ─────────────────────────────────

  let summary = '';
  let actions: VoiceLogAction[] = [];
  try {
    const extracted = await extractActionsFromTranscript(transcript);
    summary = extracted.summary;
    actions = extracted.actions;
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

  return c.json(
    {
      data: {
        voice_log_id: voiceLogId,
        transcript,
        summary,
        job_id:    jobId,
        audio_url: audioUrl,
        actions,
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
