use napi_derive::napi;
use serde::{Deserialize, Serialize};

/// Mirrors packages/policy/src/types.ts PolicyContext
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PolicyContext {
    pub workspace_id: String,
    pub agent_id: String,
    pub task_id: String,
    pub tool_type: String,
    pub tool_method: String,
    #[serde(default)]
    pub environment: Option<String>,
    #[serde(default)]
    pub data_classification: Option<String>,
    pub requested_at: String, // ISO 8601 datetime
    #[serde(default)]
    pub user_id: Option<String>,
    #[serde(default)]
    pub user_role: Option<String>,
    #[serde(default)]
    pub metadata: Option<serde_json::Value>,
}

/// Mirrors packages/policy/src/types.ts PolicyConditions
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PolicyConditions {
    #[serde(default)]
    pub tool_types: Option<Vec<String>>,
    #[serde(default)]
    pub tool_methods: Option<Vec<String>>,
    #[serde(default)]
    pub environments: Option<Vec<String>>,
    #[serde(default)]
    pub user_roles: Option<Vec<String>>,
    #[serde(default)]
    pub data_classifications: Option<Vec<String>>,
    #[serde(default)]
    pub time_window: Option<TimeWindow>,
    #[serde(default)]
    pub custom_rules: Option<serde_json::Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TimeWindow {
    pub start: String, // "HH:MM"
    pub end: String,   // "HH:MM"
}

/// Mirrors packages/policy/src/types.ts PolicyRule
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PolicyRule {
    pub id: String,
    pub workspace_id: String,
    pub name: String,
    pub enabled: bool,
    pub action: String, // "ALLOW", "DENY", "ESCALATE_TO_HUMAN"
    pub priority: i32,
    pub conditions: PolicyConditions,
    pub version: i32,
}

/// Pre-compiled rule with regex patterns
pub struct CompiledRule {
    pub rule: PolicyRule,
    pub method_patterns: Vec<regex::Regex>,
}

/// Result returned across FFI boundary to Node.js
#[napi(object)]
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PolicyDecision {
    pub matched: bool,
    pub action: String,
    pub reason: String,
    pub rule_id: Option<String>,
    pub rule_name: Option<String>,
    pub evaluation_time_us: f64, // Microseconds, not milliseconds
}

/// SQL Safety Schema — per-agent permitted SQL operations
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SafetySchema {
    #[serde(default)]
    pub permitted_statements: Vec<String>, // SELECT, INSERT, UPDATE
    #[serde(default)]
    pub permitted_tables: Vec<String>, // Allowed table names
    #[serde(default)]
    pub blocked_tables: Vec<String>, // Explicitly blocked tables
    #[serde(default)]
    pub permitted_columns: Vec<String>, // Allowed columns (if empty, all allowed)
    #[serde(default)]
    pub blocked_columns: Vec<String>, // Blocked columns (e.g. password_hash, ssn)
    #[serde(default)]
    pub max_rows_affected: Option<u64>,
    #[serde(default)]
    pub block_where_true: bool, // Block WHERE 1=1 patterns
    #[serde(default)]
    pub block_subqueries_on_restricted: bool,
}

/// Result of SQL safety evaluation
#[napi(object)]
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SqlGateDecision {
    pub allowed: bool,
    pub reason: String,
    pub statement_type: Option<String>,
    pub affected_tables: Vec<String>,
    pub blocked_columns_found: Vec<String>,
}

/// Ed25519 keypair returned to Node.js
#[napi(object)]
#[derive(Debug, Clone)]
pub struct KeyPair {
    pub public_key: String,  // PEM encoded
    pub private_key: String, // PEM encoded
}
