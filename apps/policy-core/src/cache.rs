use crate::types::{CompiledRule, PolicyRule, SafetySchema};
use dashmap::DashMap;
use std::sync::Arc;

/// Thread-safe, lock-free policy cache using DashMap.
/// One entry per workspace. O(1) reads with zero lock contention on hot path.
pub struct PolicyCache {
    /// Maps workspaceId -> (compiled_rules sorted by priority DESC, safety_schemas by agentId)
    data: DashMap<String, Arc<WorkspacePolicies>>,
}

pub struct WorkspacePolicies {
    pub rules: Vec<CompiledRule>,
    pub safety_schemas: DashMap<String, SafetySchema>, // agentId -> SafetySchema
}

impl PolicyCache {
    pub fn new() -> Self {
        Self {
            data: DashMap::new(),
        }
    }

    /// Load workspace policies from a JSON string (called from Node.js via napi).
    /// Parses rules, pre-compiles regex patterns, sorts by priority DESC.
    pub fn load_workspace(&self, workspace_id: &str, rules_json: &str, schemas_json: &str) {
        let rules: Vec<PolicyRule> = match serde_json::from_str(rules_json) {
            Ok(r) => r,
            Err(e) => {
                eprintln!(
                    "PolicyCache: Failed to parse rules for {}: {}",
                    workspace_id, e
                );
                return;
            }
        };

        let schemas: Vec<(String, SafetySchema)> = serde_json::from_str(schemas_json)
            .unwrap_or_default();

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

        // Pre-sort by priority DESC — never sort at evaluation time
        compiled.sort_by(|a, b| b.rule.priority.cmp(&a.rule.priority));

        let schema_map = DashMap::new();
        for (agent_id, schema) in schemas {
            schema_map.insert(agent_id, schema);
        }

        self.data.insert(
            workspace_id.to_string(),
            Arc::new(WorkspacePolicies {
                rules: compiled,
                safety_schemas: schema_map,
            }),
        );
    }

    /// Get compiled rules for a workspace. O(1) DashMap read, returns Arc clone (cheap).
    pub fn get(&self, workspace_id: &str) -> Option<Arc<WorkspacePolicies>> {
        self.data.get(workspace_id).map(|entry| Arc::clone(&entry))
    }

    /// Invalidate cache for a workspace. Called on policy write.
    pub fn invalidate(&self, workspace_id: &str) {
        self.data.remove(workspace_id);
    }

    /// Get safety schema for a specific agent in a workspace.
    pub fn get_safety_schema(&self, workspace_id: &str, agent_id: &str) -> Option<SafetySchema> {
        self.get(workspace_id).and_then(|wp| {
            wp.safety_schemas.get(agent_id).map(|s| s.clone())
        })
    }

    /// Return the number of workspaces currently in cache.
    pub fn size(&self) -> usize {
        self.data.len()
    }
}

/// Pre-compile glob patterns in tool_methods to regex.
/// Compilation cost is paid once at cache-load time, never at evaluation time.
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

impl Default for PolicyCache {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::PolicyConditions;

    #[test]
    fn test_load_and_retrieve() {
        let cache = PolicyCache::new();
        let rules = serde_json::json!([{
            "id": "rule1",
            "workspaceId": "ws1",
            "name": "Allow GitHub",
            "enabled": true,
            "action": "ALLOW",
            "priority": 100,
            "conditions": {
                "toolTypes": ["GITHUB"]
            },
            "version": 1
        }]);

        cache.load_workspace("ws1", &rules.to_string(), "[]");

        let result = cache.get("ws1");
        assert!(result.is_some());
        assert_eq!(result.unwrap().rules.len(), 1);
    }

    #[test]
    fn test_invalidate() {
        let cache = PolicyCache::new();
        cache.load_workspace("ws1", "[]", "[]");
        assert!(cache.get("ws1").is_some());

        cache.invalidate("ws1");
        assert!(cache.get("ws1").is_none());
    }

    #[test]
    fn test_rules_sorted_by_priority() {
        let cache = PolicyCache::new();
        let rules = serde_json::json!([
            {"id":"r1","workspaceId":"ws1","name":"Low","enabled":true,"action":"DENY","priority":10,"conditions":{},"version":1},
            {"id":"r2","workspaceId":"ws1","name":"High","enabled":true,"action":"ALLOW","priority":100,"conditions":{},"version":1},
            {"id":"r3","workspaceId":"ws1","name":"Med","enabled":true,"action":"DENY","priority":50,"conditions":{},"version":1}
        ]);

        cache.load_workspace("ws1", &rules.to_string(), "[]");
        let policies = cache.get("ws1").unwrap();
        assert_eq!(policies.rules[0].rule.priority, 100);
        assert_eq!(policies.rules[1].rule.priority, 50);
        assert_eq!(policies.rules[2].rule.priority, 10);
    }
}
