-- Adaptive quota-based allocation. Additive only: no changes to existing tables or their data.
-- All logic lives in these two functions so the Edge Functions stay thin and the behavior is testable
-- locally (scripts/simulate_allocation.py). Counts live solely in `assignments` and are never reset.
--
-- Eligibility model: GitHub's battery.json says which prompts CAN run (passed in as p_eligible by the
-- `allocate` Edge Function; a category mapped to JSON null means "no GitHub restriction"); Supabase's
-- stage_prompt_targets.is_active gates recruitment. A prompt is assignable only when both allow it —
-- disabling in either place stops new assignments without touching history.

CREATE INDEX IF NOT EXISTS assignments_stage_cat_prompt_status_idx ON assignments (stage_id, category, prompt_id, status);
COMMENT ON COLUMN assignments.participant_key IS 'extension-generated participant key (random UUID kept in the participant''s browser) — NOT the Prolific ID, which never leaves the browser; join to Prolific identities via the uploaded JSON (participant_key ↔ participant_id)';

-- One pending assignment per battery category for this participant, idempotent and atomic.
-- deficit = max(0, target - submitted - alpha * pending); selection probability ∝ deficit.
-- All deficits 0 (quota reached) → the least-over-target prompt is assigned and the category is
-- reported in `exhausted` — explicit overflow, never a silent uniform fallback.
CREATE OR REPLACE FUNCTION allocate_prompts(p_participant_key text, p_eligible jsonb, p_alpha numeric DEFAULT 0.6, p_ttl_minutes int DEFAULT 70)
RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE
  v_n int;
  v_stage text;
  v_cat text;
  v_ids jsonb;
  v_list text[];
  v_exhausted text[] := '{}';
  v_out jsonb;
  rec record;
BEGIN
  IF p_participant_key !~ '^[A-Za-z0-9_-]{1,64}$' THEN RAISE EXCEPTION 'invalid participant_key'; END IF;
  SELECT count(*), min(id) INTO v_n, v_stage FROM study_stages WHERE is_active;
  IF v_n <> 1 THEN RAISE EXCEPTION '% active stages (need exactly 1)', v_n; END IF;

  -- Serialize allocations per stage: counts below are race-free, and a duplicate concurrent request
  -- for the same participant waits here and then takes the existing-assignments path.
  PERFORM pg_advisory_xact_lock(hashtext('piw_allocate_' || v_stage));

  -- Lazy expiration: abandoned pending assignments stop holding quota.
  UPDATE assignments SET status = 'expired' WHERE stage_id = v_stage AND status = 'pending' AND expires_at < now();

  -- Returning participants keep their original assignments, whatever the status — never rerandomized. Only
  -- categories added to the battery after their first allocation fall through to the loop and get filled in.
  SELECT jsonb_object_agg(category, prompt_id) INTO v_out FROM assignments WHERE participant_key = p_participant_key AND stage_id = v_stage;
  v_n := (v_out IS NOT NULL)::int;
  v_out := coalesce(v_out, '{}'::jsonb);
  FOR v_cat, v_ids IN SELECT key, value FROM jsonb_each(p_eligible) LOOP
    CONTINUE WHEN v_out ? v_cat;
    v_list := CASE WHEN jsonb_typeof(v_ids) = 'array' THEN ARRAY(SELECT jsonb_array_elements_text(v_ids)) END;
    -- Weighted pick by exponential race: min of -ln(U)/deficit lands on each prompt with P ∝ deficit.
    -- Zero-deficit rows sort last by overflow, so an exhausted category yields the least-over-target prompt.
    SELECT c.prompt_id, c.deficit INTO rec FROM (
      SELECT t.prompt_id,
             greatest(0, t.target - s.submitted - p_alpha * s.pending) AS deficit,
             s.submitted + p_alpha * s.pending - t.target AS overflow
      FROM stage_prompt_targets t
      CROSS JOIN LATERAL (
        SELECT count(*) FILTER (WHERE a.status = 'submitted') AS submitted,
               count(*) FILTER (WHERE a.status = 'pending') AS pending
        FROM assignments a
        WHERE a.stage_id = t.stage_id AND a.category = t.category AND a.prompt_id = t.prompt_id
      ) s
      WHERE t.stage_id = v_stage AND t.category = v_cat AND t.is_active
        AND (v_list IS NULL OR t.prompt_id = ANY (v_list))
    ) c
    ORDER BY CASE WHEN c.deficit > 0 THEN -ln(random() + 1e-12) / c.deficit END NULLS LAST, c.overflow
    LIMIT 1;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'no eligible active prompts for category %', v_cat;
    END IF;
    IF rec.deficit = 0 THEN v_exhausted := v_exhausted || v_cat; END IF;
    INSERT INTO assignments (participant_key, stage_id, category, prompt_id, status, assigned_at, expires_at)
    VALUES (p_participant_key, v_stage, v_cat, rec.prompt_id, 'pending', now(), now() + make_interval(mins => p_ttl_minutes));
    v_out := v_out || jsonb_build_object(v_cat, rec.prompt_id);
  END LOOP;

  RETURN jsonb_build_object('stage_id', v_stage, 'assignments', v_out, 'exhausted', to_jsonb(v_exhausted), 'existing', v_n = 1);
END $$;

-- Marks the participant's assignments submitted when the extension records the JSON download.
-- pending and expired both flip (late submissions allowed); already-submitted rows are untouched,
-- so repeated downloads never count twice and submitted_at keeps its first value.
CREATE OR REPLACE FUNCTION submit_assignments(p_participant_key text, p_stage_id text)
RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE
  v_updated int;
  v_total int;
BEGIN
  IF p_participant_key !~ '^[A-Za-z0-9_-]{1,64}$' THEN RAISE EXCEPTION 'invalid participant_key'; END IF;
  -- Same per-stage lock as allocate_prompts, so an allocation never reads counts while a submit is mid-flip.
  PERFORM pg_advisory_xact_lock(hashtext('piw_allocate_' || p_stage_id));
  UPDATE assignments SET status = 'submitted', submitted_at = now()
  WHERE participant_key = p_participant_key AND stage_id = p_stage_id AND status IN ('pending', 'expired');
  GET DIAGNOSTICS v_updated = ROW_COUNT;
  SELECT count(*) INTO v_total FROM assignments WHERE participant_key = p_participant_key AND stage_id = p_stage_id;
  IF v_total = 0 THEN RAISE EXCEPTION 'no assignments for this participant'; END IF;
  RETURN jsonb_build_object('updated', v_updated, 'total', v_total);
END $$;

-- Only the Edge Functions (service role) may call these. Revoking PUBLIC is not enough on Supabase: the
-- platform's default privileges grant EXECUTE on new public-schema functions directly to anon/authenticated
-- (reachable as POST /rest/v1/rpc/... with the publishable key), so those grants are revoked explicitly.
REVOKE ALL ON FUNCTION allocate_prompts(text, jsonb, numeric, int) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION submit_assignments(text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION allocate_prompts(text, jsonb, numeric, int) TO service_role;
GRANT EXECUTE ON FUNCTION submit_assignments(text, text) TO service_role;
