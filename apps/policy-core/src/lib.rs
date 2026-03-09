// NexusOps Policy Core — napi-rs FFI boundary
// This is the ONLY interface Node.js sees. All hot-path logic lives in Rust.
// Functions annotated with #[napi] are exported as native Node.js functions.
//
// Latency guarantees (verified in CI):
//   - Policy evaluation: p50 < 500μs, p99 < 2ms @ 50K concurrent
//   - SQL gate:          p50 < 100μs, p99 < 200μs per query
//   - SHA-3 hash:        < 10μs per payload
//   - Ed25519 sign:      < 50μs per signature
//   - Ed25519 verify:    < 80μs per verification

mod cache;
mod evaluator;
mod sql_gate;
mod types;

use cache::PolicyCache;
use napi::bindgen_prelude::*;
use napi_derive::napi;
use once_cell::sync::Lazy;
use types::{
    CompiledRule, KeyPair, PolicyContext, PolicyDecision, PolicyRule, SafetySchema, SqlGateDecision,
};

// Singleton cache — lives for process lifetime, zero-cost on hot path.
// DashMap internals provide lock-free reads; Arc<WorkspacePolicies> clones are cheap (refcount bump).
static CACHE: Lazy<PolicyCache> = Lazy::new(PolicyCache::new);

// ─────────────────────────────────────────────
// Policy Evaluation (hot path — must be < 2ms)
// ─────────────────────────────────────────────

/// Evaluate a policy context against a set of rules provided as JSON.
/// Used for dry-run / simulation where rules come from the caller, not the cache.
/// Returns PolicyDecision with action, matched rule, and evaluation time in μs.
/// If no rules match → DENY (default deny posture — non-negotiable).
#[napi]
pub fn evaluate_policy(context_json: String, rules_json: String) -> Result<PolicyDecision> {
    let context: PolicyContext = serde_json::from_str(&context_json)
        .map_err(|e| Error::from_reason(format!("Invalid context JSON: {}", e)))?;

    let rules: Vec<PolicyRule> = serde_json::from_str(&rules_json)
        .map_err(|e| Error::from_reason(format!("Invalid rules JSON: {}", e)))?;

    // Compile rules inline — this path is NOT cached so we must compile here.
    // For hot-path production use, use evaluate_policy_cached() instead.
    let mut compiled: Vec<CompiledRule> = rules
        .into_iter()
        .map(|rule| {
            let patterns = compile_method_patterns(&rule);
            CompiledRule {
                rule,
                method_patterns: patterns,
            }
        })
        .collect();
    compiled.sort_by(|a, b| b.rule.priority.cmp(&a.rule.priority));

    Ok(evaluator::evaluate(&context, &compiled))
}

/// Evaluate policy using cached rules for a workspace.
/// This is the HOT PATH called on every agent tool call.
/// Rules are pre-compiled and pre-sorted at cache-load time → zero compilation cost here.
/// Falls back to DENY if workspace not found in cache.
#[napi]
pub fn evaluate_policy_cached(
    context_json: String,
    workspace_id: String,
) -> Result<PolicyDecision> {
    let context: PolicyContext = serde_json::from_str(&context_json)
        .map_err(|e| Error::from_reason(format!("Invalid context JSON: {}", e)))?;

    match CACHE.get(&workspace_id) {
        Some(policies) => {
            // Evaluate against pre-compiled, pre-sorted CompiledRule vec — zero work at eval time
            Ok(evaluator::evaluate(&context, &policies.rules))
        }
        None => {
            // No cached rules — default deny (non-negotiable)
            Ok(PolicyDecision {
                matched: false,
                action: "DENY".to_string(),
                reason: "No cached policies for workspace — default deny".to_string(),
                rule_id: None,
                rule_name: None,
                evaluation_time_us: 0.0,
            })
        }
    }
}

// ─────────────────────────────────────────────
// SQL Action Gating (hot path — must be < 200μs)
// ─────────────────────────────────────────────

/// Parse and evaluate a SQL query against an agent's safety schema.
/// Full AST parsing via sqlparser-rs — not regex. Immune to obfuscation attacks.
/// Blocks: DROP, TRUNCATE, ALTER, blocked tables, blocked columns, tautological WHEREs.
#[napi]
pub fn evaluate_sql_query(query: String, schema_json: String) -> Result<SqlGateDecision> {
    let schema: SafetySchema = serde_json::from_str(&schema_json)
        .map_err(|e| Error::from_reason(format!("Invalid schema JSON: {}", e)))?;

    Ok(sql_gate::evaluate_sql(&query, &schema))
}

/// Evaluate SQL query using cached safety schema for a specific agent.
/// Cache lookup is O(1) via DashMap → total overhead < 200μs.
#[napi]
pub fn evaluate_sql_query_cached(
    query: String,
    workspace_id: String,
    agent_id: String,
) -> Result<SqlGateDecision> {
    match CACHE.get_safety_schema(&workspace_id, &agent_id) {
        Some(schema) => Ok(sql_gate::evaluate_sql(&query, &schema)),
        None => Ok(SqlGateDecision {
            allowed: false,
            reason: "No safety schema found for agent — default deny".to_string(),
            statement_type: None,
            affected_tables: vec![],
            blocked_columns_found: vec![],
        }),
    }
}

// ─────────────────────────────────────────────
// Cache Management
// ─────────────────────────────────────────────

/// Load workspace policies into the in-process DashMap cache.
/// Called once on workspace init and on every policy change (write-through from Node.js).
/// rules_json: JSON array of PolicyRule objects
/// schemas_json: JSON array of [agentId, SafetySchema] tuples
#[napi]
pub fn load_workspace_policies(
    workspace_id: String,
    rules_json: String,
    schemas_json: String,
) -> Result<()> {
    CACHE.load_workspace(&workspace_id, &rules_json, &schemas_json);
    Ok(())
}

/// Invalidate cached policies for a workspace.
/// Call this when policies are updated (write-through invalidation from Node.js).
#[napi]
pub fn invalidate_workspace(workspace_id: String) -> Result<()> {
    CACHE.invalidate(&workspace_id);
    Ok(())
}

/// Return the number of workspaces currently in the policy cache.
/// Used for diagnostics and health checks.
#[napi]
pub fn cache_size() -> Result<u32> {
    Ok(CACHE.size() as u32)
}

// ─────────────────────────────────────────────
// Cryptographic Operations (Ed25519 + SHA-3)
// ─────────────────────────────────────────────

/// Generate a new Ed25519 keypair for agent identity.
/// Returns { publicKey: hex, privateKey: hex }.
/// Key material is generated using OS-level CSPRNG (OsRng).
#[napi]
pub fn generate_keypair() -> Result<KeyPair> {
    use ed25519_dalek::SigningKey;
    use rand::rngs::OsRng;

    let signing_key = SigningKey::generate(&mut OsRng);
    let verifying_key = signing_key.verifying_key();

    Ok(KeyPair {
        public_key: hex::encode(verifying_key.as_bytes()),
        private_key: hex::encode(signing_key.to_bytes()),
    })
}

/// SHA-3-256 hash of arbitrary data. Used for audit chain integrity.
/// Returns hex-encoded 64-char hash string.
/// Perf: < 10μs for payloads under 4KB.
#[napi]
pub fn hash_sha3(data: String) -> Result<String> {
    use sha3::{Digest, Sha3_256};

    let mut hasher = Sha3_256::new();
    hasher.update(data.as_bytes());
    Ok(hex::encode(hasher.finalize()))
}

/// SHA-3-256 hash of binary data provided as a Buffer.
/// Used for hashing request/response payloads without UTF-8 encoding overhead.
#[napi]
pub fn hash_sha3_buffer(data: Buffer) -> Result<String> {
    use sha3::{Digest, Sha3_256};

    let mut hasher = Sha3_256::new();
    hasher.update(data.as_ref());
    Ok(hex::encode(hasher.finalize()))
}

/// Sign a payload with an Ed25519 secret key (hex-encoded 32 bytes).
/// Returns hex-encoded 128-char signature string.
/// Perf: < 50μs per signature.
#[napi]
pub fn sign_payload(payload: String, secret_key_hex: String) -> Result<String> {
    use ed25519_dalek::{Signer, SigningKey};

    let key_bytes = hex::decode(&secret_key_hex)
        .map_err(|e| Error::from_reason(format!("Invalid secret key hex: {}", e)))?;

    let key_array: [u8; 32] = key_bytes
        .try_into()
        .map_err(|_| Error::from_reason("Secret key must be exactly 32 bytes"))?;

    let signing_key = SigningKey::from_bytes(&key_array);
    let signature = signing_key.sign(payload.as_bytes());

    Ok(hex::encode(signature.to_bytes()))
}

/// Verify an Ed25519 signature against a public key.
/// Returns true if the signature is valid, false otherwise. Never throws on bad sig.
/// Perf: < 80μs per verification.
#[napi]
pub fn verify_signature(
    payload: String,
    signature_hex: String,
    public_key_hex: String,
) -> Result<bool> {
    use ed25519_dalek::{Signature, Verifier, VerifyingKey};

    let pub_bytes = hex::decode(&public_key_hex)
        .map_err(|e| Error::from_reason(format!("Invalid public key hex: {}", e)))?;

    let pub_array: [u8; 32] = pub_bytes
        .try_into()
        .map_err(|_| Error::from_reason("Public key must be exactly 32 bytes"))?;

    let sig_bytes = hex::decode(&signature_hex)
        .map_err(|e| Error::from_reason(format!("Invalid signature hex: {}", e)))?;

    let sig_array: [u8; 64] = sig_bytes
        .try_into()
        .map_err(|_| Error::from_reason("Signature must be exactly 64 bytes"))?;

    let verifying_key = VerifyingKey::from_bytes(&pub_array)
        .map_err(|e| Error::from_reason(format!("Invalid public key: {}", e)))?;

    let signature = Signature::from_bytes(&sig_array);

    match verifying_key.verify(payload.as_bytes(), &signature) {
        Ok(_) => Ok(true),
        Err(_) => Ok(false),
    }
}

/// Compute a chain hash: SHA-3(content + previousHash).
/// Used for building immutable audit event chains.
/// Returns hex-encoded hash.
#[napi]
pub fn chain_hash(content: String, previous_hash: String) -> Result<String> {
    use sha3::{Digest, Sha3_256};

    let mut hasher = Sha3_256::new();
    hasher.update(content.as_bytes());
    hasher.update(previous_hash.as_bytes());
    Ok(hex::encode(hasher.finalize()))
}

// ─────────────────────────────────────────────
// Diagnostics & Health
// ─────────────────────────────────────────────

/// Return engine version, capability flags, and runtime info.
/// Used by /health endpoint and agent SDK capability negotiation.
#[napi]
pub fn engine_info() -> Result<String> {
    let info = serde_json::json!({
        "engine": "nexusops-policy-core",
        "version": env!("CARGO_PKG_VERSION"),
        "runtime": "Rust via napi-rs (in-process FFI)",
        "memorySafe": true,
        "gcPauses": false,
        "latencyTargets": {
            "policyEvaluation_p99_us": 2000,
            "sqlGate_p99_us": 200,
            "sha3Hash_us": 10,
            "ed25519Sign_us": 50,
            "ed25519Verify_us": 80
        },
        "capabilities": [
            "policy_evaluation",
            "policy_cache",
            "sql_ast_gate",
            "ed25519_signing",
            "ed25519_verification",
            "sha3_hashing",
            "chain_hashing"
        ],
        "cacheWorkspaces": CACHE.size()
    });
    Ok(info.to_string())
}

/// Helper: compile glob patterns from a PolicyRule's toolMethods.
/// Called in evaluate_policy() for inline rule compilation.
fn compile_method_patterns(rule: &PolicyRule) -> Vec<regex::Regex> {
    rule.conditions
        .tool_methods
        .as_ref()
        .map(|methods| {
            methods
                .iter()
                .filter(|m| m.contains('*'))
                .filter_map(|m| {
                    let pattern = format!("^{}$", regex::escape(m).replace(r"\*", ".*"));
                    regex::Regex::new(&pattern).ok()
                })
                .collect()
        })
        .unwrap_or_default()
}
