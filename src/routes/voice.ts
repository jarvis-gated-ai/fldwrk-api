import { Hono } from 'hono';
import OpenAI from 'openai';
import { z } from 'zod';
import { zValidator } from '@hono/zod-validator';
import { authMiddleware, AuthVariables } from '../middleware/auth';
import { createUserClient, supabaseAdmin } from '../lib/supabase';

export const voiceRouter = new Hono<{ Variables: AuthVariables }>();

voiceRouter.use('*', authMiddleware);

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const STORAGE_BUCKET = process.env.SUPABASE_STORAGE_BUCKET ?? 'voice-recordings';

// ─── POST /api/v1/voice/transcribe ────────────
// Accepts multipart/form-data with:
//   - audio: audio file (mp4, m4a, wav, mp3, webm)
//   - job_id: UUID of the associated job

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

  const jobId = (formData.get('job_id') as string | null) || null;
  const audioFile = formData.get('audio') as File | null;

  if (!audioFile) {
    return c.json({ error: { message: 'audio file is required', code: 'VALIDATION_ERROR' } }, 400);
  }

  // Only validate job ownership if a job_id was provided
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

  // ── 1. Upload audio to Supabase Storage ──────

  const audioBuffer = await audioFile.arrayBuffer();
  const audioBytes = new Uint8Array(audioBuffer);
  const fileExt = audioFile.name.split('.').pop() ?? 'mp4';
  const storagePath = `${userId}/${jobId ?? 'unlinked'}/${Date.now()}.${fileExt}`;

  const { data: uploadData, error: uploadError } = await supabaseAdmin.storage
    .from(STORAGE_BUCKET)
    .upload(storagePath, audioBytes, {
      contentType: audioFile.type,
      upsert: false,
    });

  if (uploadError) {
    console.error('[Voice] Storage upload error:', uploadError);
    return c.json(
      { error: { message: 'Failed to upload audio file', code: 'STORAGE_ERROR' } },
      500
    );
  }

  const { data: publicUrlData } = supabaseAdmin.storage
    .from(STORAGE_BUCKET)
    .getPublicUrl(storagePath);

  const audioUrl = publicUrlData?.publicUrl ?? null;

  // ── 2. Transcribe with Whisper ───────────────

  let transcript = '';
  try {
    // OpenAI expects a File-like object
    const openaiFile = new File([audioBytes], `recording.${fileExt}`, { type: audioFile.type });

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

  // ── 3. Generate summary with GPT-4o ──────────

  let summary = '';
  try {
    const summaryResponse = await openai.chat.completions.create({
      model: 'gpt-4o',
      messages: [
        {
          role: 'system',
          content: `You are a field service assistant for a trade business (plumbing, HVAC, electrical, etc.).
Summarize the following voice note into a concise 2-3 sentence job update.
Focus on: work performed, issues found, parts needed, follow-up actions.
Be direct and professional.`,
        },
        {
          role: 'user',
          content: `Voice note transcript:\n\n${transcript}`,
        },
      ],
      max_tokens: 200,
      temperature: 0.3,
    });

    summary = summaryResponse.choices[0]?.message?.content ?? '';
  } catch (err) {
    console.error('[Voice] GPT-4o summary error:', err);
    // Non-fatal — we still have the transcript
    summary = '';
  }

  // ── 4. Store voice log in DB ─────────────────

  const { data: voiceLog, error: dbError } = await supabaseAdmin
    .from('voice_logs')
    .insert({
      job_id: jobId ?? null,
      user_id: userId,
      audio_url: audioUrl,
      transcript,
      summary,
    })
    .select()
    .single();

  if (dbError) {
    console.error('[Voice] DB insert error:', dbError);
    return c.json(
      { error: { message: 'Failed to save voice log', code: 'DB_ERROR' } },
      500
    );
  }

  return c.json(
    {
      data: {
        voice_log_id: voiceLog.id,
        transcript,
        summary,
        job_id: jobId,
        audio_url: audioUrl,
      },
    },
    201
  );
});

// ─── GET /api/v1/voice/:job_id ────────────────
// Fetch all voice logs for a given job

voiceRouter.get('/:job_id', async (c) => {
  const jobId = c.req.param('job_id');
  const jwt = c.get('jwt');
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
