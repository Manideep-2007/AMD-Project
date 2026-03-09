-- CreateTriggersForAppendOnlyTables
-- Prevents UPDATE and DELETE on audit_events, compliance_artifacts, tool_calls, and policy_evaluations

-- ─── audit_events ─────────────────────────────────────
CREATE OR REPLACE FUNCTION prevent_audit_mutation()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION
    'audit_events is append-only. Mutation of record % is forbidden.', OLD.id
    USING ERRCODE = 'insufficient_privilege';
  RETURN NULL;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE TRIGGER audit_events_immutable
BEFORE UPDATE OR DELETE ON audit_events
FOR EACH ROW EXECUTE FUNCTION prevent_audit_mutation();

-- ─── compliance_artifacts ─────────────────────────────
CREATE OR REPLACE FUNCTION prevent_artifact_mutation()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION
    'compliance_artifacts is append-only. Mutation of record % is forbidden.', OLD.id
    USING ERRCODE = 'insufficient_privilege';
  RETURN NULL;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE TRIGGER compliance_artifacts_immutable
BEFORE UPDATE OR DELETE ON compliance_artifacts
FOR EACH ROW EXECUTE FUNCTION prevent_artifact_mutation();

-- ─── tool_calls ───────────────────────────────────────
CREATE OR REPLACE FUNCTION prevent_tool_call_mutation()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION
    'tool_calls is append-only. Mutation of record % is forbidden.', OLD.id
    USING ERRCODE = 'insufficient_privilege';
  RETURN NULL;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE TRIGGER tool_calls_immutable
BEFORE UPDATE OR DELETE ON tool_calls
FOR EACH ROW EXECUTE FUNCTION prevent_tool_call_mutation();

-- ─── policy_evaluations ──────────────────────────────
CREATE OR REPLACE FUNCTION prevent_policy_eval_mutation()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION
    'policy_evaluations is append-only. Mutation of record % is forbidden.', OLD.id
    USING ERRCODE = 'insufficient_privilege';
  RETURN NULL;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE TRIGGER policy_evaluations_immutable
BEFORE UPDATE OR DELETE ON policy_evaluations
FOR EACH ROW EXECUTE FUNCTION prevent_policy_eval_mutation();
