-- AddTaskImmutabilityTriggers
-- SOC 2 CC6.1 / CC7.2: tasks and task_approvals are evidence records.
-- Tasks must never be deleted, and their immutable fields must not be altered.
-- Task approval decisions are final once decidedAt is set; they cannot be retracted.

-- ─── tasks: block DELETE ──────────────────────────────────────────────────────
-- Tasks are permanent operational records. Deletion would break audit trail linkage
-- (tool_calls, compliance_artifacts, policy_evaluations all reference the task).
CREATE OR REPLACE FUNCTION prevent_task_delete()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION
    'tasks are permanent evidence records and may not be deleted (id: %). '
    'Retain tasks for the full data-retention period defined in your DPA.',
    OLD.id
    USING ERRCODE = 'insufficient_privilege';
  RETURN NULL;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE TRIGGER tasks_no_delete
BEFORE DELETE ON tasks
FOR EACH ROW EXECUTE FUNCTION prevent_task_delete();

-- ─── tasks: protect immutable fields on UPDATE ───────────────────────────────
-- Status, output, error, tokenCount, costUsd, startedAt, completedAt, updatedAt
-- are intentionally mutable (operational lifecycle updates).
-- The DEFINITIVE content fields — input, traceId, agentId, workspaceId, createdAt
-- — must never change once written.
CREATE OR REPLACE FUNCTION protect_task_immutable_fields()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.id          IS DISTINCT FROM OLD.id          THEN
    RAISE EXCEPTION 'tasks.id is immutable (task: %)', OLD.id
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW.workspaceId IS DISTINCT FROM OLD.workspaceId THEN
    RAISE EXCEPTION 'tasks.workspaceId is immutable (task: %)', OLD.id
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW.agentId     IS DISTINCT FROM OLD.agentId     THEN
    RAISE EXCEPTION 'tasks.agentId is immutable (task: %)', OLD.id
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW.traceId     IS DISTINCT FROM OLD.traceId     THEN
    RAISE EXCEPTION 'tasks.traceId is immutable (task: %)', OLD.id
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW.input       IS DISTINCT FROM OLD.input       THEN
    RAISE EXCEPTION 'tasks.input is immutable once set (task: %)', OLD.id
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW.createdAt   IS DISTINCT FROM OLD.createdAt   THEN
    RAISE EXCEPTION 'tasks.createdAt is immutable (task: %)', OLD.id
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE TRIGGER tasks_immutable_fields
BEFORE UPDATE ON tasks
FOR EACH ROW EXECUTE FUNCTION protect_task_immutable_fields();

-- ─── task_approvals: block DELETE ────────────────────────────────────────────
-- Approval decisions are human-in-the-loop evidence for high-risk agent actions.
-- Deletion would erase compliance evidence of who approved what and when.
CREATE OR REPLACE FUNCTION prevent_task_approval_delete()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION
    'task_approvals are permanent evidence records and may not be deleted (id: %). '
    'Approval decisions are immutable for SOC 2 compliance.',
    OLD.id
    USING ERRCODE = 'insufficient_privilege';
  RETURN NULL;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE TRIGGER task_approvals_no_delete
BEFORE DELETE ON task_approvals
FOR EACH ROW EXECUTE FUNCTION prevent_task_approval_delete();

-- ─── task_approvals: freeze record once a decision is made ───────────────────
-- Once decidedAt is set (a decision was recorded), the entire approval row
-- is sealed. No fields may change — not even the timeout deadline or risk score.
CREATE OR REPLACE FUNCTION prevent_decided_approval_mutation()
RETURNS TRIGGER AS $$
BEGIN
  -- Allow the initial decision to be written (OLD.decidedAt was NULL)
  IF OLD.decidedAt IS NOT NULL THEN
    RAISE EXCEPTION
      'task_approvals with a recorded decision are immutable (id: %, decidedAt: %). '
      'Approval decisions cannot be retracted or altered.',
      OLD.id, OLD.decidedAt
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE TRIGGER task_approvals_decision_immutable
BEFORE UPDATE ON task_approvals
FOR EACH ROW EXECUTE FUNCTION prevent_decided_approval_mutation();
