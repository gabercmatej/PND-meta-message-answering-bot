-- EXCERPT from a private codebase (db/migrations/0009_inbox_publishing.sql), trimmed for illustration.
-- Most columns, indexes and the settings table are omitted.
--
-- Hard invariants enforced in the DATABASE, in addition to application code:
--   1. A reply item created in SHADOW can never become approved/scheduled/sending/sent/outcome_unknown.
--   2. No reply item may move into approved/scheduled/sending while publishing is paused or while
--      the global mode or the account mode is below REVIEW.
--   3. A publish attempt can only be recorded for a non-SHADOW item that is in `sending`.
--   4. At most one open (pending / outcome_unknown) attempt per reply item: no parallel sends and no
--      blind resend after an unknown outcome.
--   5. The AI draft of a decision is never overwritten; a sent item is final; the text of an
--      attempt is immutable once recorded.

CREATE TABLE reply_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  mode_at_creation text NOT NULL CHECK (mode_at_creation IN ('SHADOW', 'REVIEW', 'LIVE')),
  state text NOT NULL DEFAULT 'new' CHECK (state IN (
    'new', 'processing', 'needs_review', 'approved', 'scheduled', 'sending', 'sent',
    'skipped', 'failed', 'cancelled', 'held', 'outcome_unknown', 'handled'
  )),
  draft_text text,            -- AI (or approved release) draft; only replaced together with a new decision
  final_text text,            -- the human's text, stored separately
  edited_by_human boolean NOT NULL DEFAULT false,
  platform_send_id text,
  sent_at timestamptz,
  idempotency_key text NOT NULL UNIQUE,
  row_version integer NOT NULL DEFAULT 1,
  -- ... (managed_account_id, surface, decision_id and source links, reviewer, schedule, failure fields, timestamps)
  -- Invariant 1: SHADOW can never send, schedule or be approved.
  CONSTRAINT reply_items_shadow_never_sends CHECK (
    mode_at_creation <> 'SHADOW' OR state NOT IN ('approved', 'scheduled', 'sending', 'sent', 'outcome_unknown')
  ),
  CONSTRAINT reply_items_sent_has_platform_id CHECK (state <> 'sent' OR (platform_send_id IS NOT NULL AND sent_at IS NOT NULL))
);

CREATE FUNCTION reply_items_guard() RETURNS trigger AS $fn$
DECLARE
  ctl record;
  account_mode text;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF OLD.state = 'sent' AND (NEW.state <> 'sent' OR NEW.final_text IS DISTINCT FROM OLD.final_text
       OR NEW.platform_send_id IS DISTINCT FROM OLD.platform_send_id) THEN
      RAISE EXCEPTION 'a sent reply item is final';
    END IF;
    IF NEW.draft_text IS DISTINCT FROM OLD.draft_text AND NEW.decision_id IS NOT DISTINCT FROM OLD.decision_id THEN
      RAISE EXCEPTION 'the AI draft of a decision is never overwritten';
    END IF;
  END IF;
  -- Invariant 2: entering a send-capable state needs an unpaused, REVIEW-or-LIVE system.
  IF NEW.state IN ('approved', 'scheduled', 'sending') AND (TG_OP = 'INSERT' OR NEW.state IS DISTINCT FROM OLD.state) THEN
    SELECT global_mode, paused INTO ctl FROM runtime_controls WHERE id = 1;
    SELECT mode INTO account_mode FROM managed_accounts WHERE id = NEW.managed_account_id;
    IF ctl.paused THEN
      RAISE EXCEPTION 'publishing is paused: reply item cannot enter %', NEW.state;
    END IF;
    IF ctl.global_mode NOT IN ('REVIEW', 'LIVE') OR account_mode NOT IN ('REVIEW', 'LIVE') THEN
      RAISE EXCEPTION 'mode does not allow publishing: reply item cannot enter %', NEW.state;
    END IF;
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END
$fn$ LANGUAGE plpgsql;

-- Exact text and state are recorded BEFORE the write to Meta.
CREATE TABLE publish_attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reply_item_id uuid NOT NULL REFERENCES reply_items(id) ON DELETE CASCADE,
  attempt_no integer NOT NULL CHECK (attempt_no > 0),
  idempotency_key text NOT NULL UNIQUE,
  text_sent text NOT NULL CHECK (length(text_sent) BETWEEN 1 AND 8000),
  text_sha256 text NOT NULL,
  state text NOT NULL DEFAULT 'pending' CHECK (state IN (
    'pending', 'succeeded', 'failed_retryable', 'failed_permanent', 'outcome_unknown', 'reconciled_sent', 'reconciled_absent'
  )),
  -- ... (endpoint, target, Graph error fields, reconciliation counters, timestamps)
  UNIQUE (reply_item_id, attempt_no)
);

-- Invariant 4: no parallel sends and no blind resend after an unknown outcome.
CREATE UNIQUE INDEX publish_attempts_one_open ON publish_attempts (reply_item_id) WHERE state IN ('pending', 'outcome_unknown');

CREATE FUNCTION publish_attempts_guard() RETURNS trigger AS $fn$
DECLARE
  item record;
BEGIN
  IF TG_OP = 'INSERT' THEN
    SELECT mode_at_creation, state INTO item FROM reply_items WHERE id = NEW.reply_item_id;
    -- Invariant 3.
    IF item.mode_at_creation = 'SHADOW' THEN
      RAISE EXCEPTION 'a SHADOW reply item can never be published';
    END IF;
    IF item.state <> 'sending' THEN
      RAISE EXCEPTION 'a publish attempt requires the reply item to be in sending (is %)', item.state;
    END IF;
  ELSE
    IF NEW.text_sent IS DISTINCT FROM OLD.text_sent OR NEW.text_sha256 IS DISTINCT FROM OLD.text_sha256
       OR NEW.reply_item_id IS DISTINCT FROM OLD.reply_item_id THEN
      RAISE EXCEPTION 'a recorded publish attempt is immutable';
    END IF;
  END IF;
  RETURN NEW;
END
$fn$ LANGUAGE plpgsql;
