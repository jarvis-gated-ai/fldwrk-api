/**
 * Account management routes — FLDWRK API
 *
 * DELETE /api/v1/account
 *   Permanently deletes the authenticated user's account:
 *   1. Deletes all storage files (profile image, voice recordings, support attachments)
 *   2. Deletes the company record (cascades to all company data via FK)
 *   3. Deletes the auth user (cascades to public.users record)
 *
 * Apple Guideline 5.1.1(v) compliant — full data erasure, not soft-delete.
 */

import { Hono } from 'hono';
import { supabaseAdmin } from '../lib/supabase';
import { authMiddleware, AuthVariables } from '../middleware/auth';

export const accountRouter = new Hono<{ Variables: AuthVariables }>();

// ─── DELETE /api/v1/account ───────────────────────────────────────────────────

accountRouter.delete(
  '/',
  authMiddleware,
  async (c) => {
    const userId    = c.get('userId');
    const companyId = c.get('companyId');

    try {
      // ── 1. Delete storage files ──────────────────────────────────────────

      // Profile image: stored as {userId}.{ext} in profile-images bucket
      const { data: profileFiles } = await supabaseAdmin.storage
        .from('profile-images')
        .list('', { search: userId });
      if (profileFiles && profileFiles.length > 0) {
        await supabaseAdmin.storage
          .from('profile-images')
          .remove(profileFiles.map((f) => f.name));
      }

      // Voice recordings: stored in voice-recordings/{companyId}/
      if (companyId) {
        const { data: voiceFiles } = await supabaseAdmin.storage
          .from('voice-recordings')
          .list(companyId, { limit: 1000 });
        if (voiceFiles && voiceFiles.length > 0) {
          await supabaseAdmin.storage
            .from('voice-recordings')
            .remove(voiceFiles.map((f) => `${companyId}/${f.name}`));
        }
      }

      // Support attachments: stored in support-attachments/{userId}/
      const { data: supportFiles } = await supabaseAdmin.storage
        .from('support-attachments')
        .list(userId, { limit: 1000 });
      if (supportFiles && supportFiles.length > 0) {
        await supabaseAdmin.storage
          .from('support-attachments')
          .remove(supportFiles.map((f) => `${userId}/${f.name}`));
      }

      // ── 2. Delete company record (cascades to all company data) ──────────
      // Only delete if this user is the owner and there are no other team members.
      // If other members exist, just remove this user from the company.
      if (companyId) {
        const { data: teamMembers } = await supabaseAdmin
          .from('users')
          .select('id')
          .eq('company_id', companyId);

        const otherMembers = (teamMembers ?? []).filter((m) => m.id !== userId);

        if (otherMembers.length === 0) {
          // Sole member — delete company (cascades to all company data)
          await supabaseAdmin.from('companies').delete().eq('id', companyId);
        }
        // If other members exist, the public.users cascade will handle this user's records
      }

      // ── 3. Delete auth user (cascades to public.users → all remaining data) ──
      const { error: deleteErr } = await supabaseAdmin.auth.admin.deleteUser(userId);
      if (deleteErr) {
        console.error('[Account/delete] Auth user deletion failed:', deleteErr.message);
        return c.json(
          { error: { message: `Failed to delete account: ${deleteErr.message}`, code: 'DELETE_FAILED' } },
          500
        );
      }

      console.log(`[Account/delete] Successfully deleted user ${userId}`);
      return c.json({ ok: true, message: 'Account permanently deleted.' });

    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Unknown error';
      console.error('[Account/delete] Unexpected error:', msg);
      return c.json(
        { error: { message: `Account deletion failed: ${msg}`, code: 'DELETE_FAILED' } },
        500
      );
    }
  }
);
