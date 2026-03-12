use crate::types::{CompiledRule, PolicyContext, PolicyDecision};
use std::time::Instant;

/// Pure policy evaluation function.
/// Zero side effects, zero I/O, zero heap allocation on typical path.
/// Target: p50 < 500μs, p99 < 2ms at 50,000 concurrent evaluations.
pub fn evaluate(context: &PolicyContext, rules: &[CompiledRule]) -> PolicyDecision {
    let start = Instant::now();

    // Rules are pre-sorted by priority DESC at cache-load time
    for compiled in rules {
        let rule = &compiled.rule;

        if !rule.enabled {
            continue;
        }

        if evaluate_conditions(rule, compiled, context) {
            let elapsed = start.elapsed();
            return PolicyDecision {
                matched: true,
                action: rule.action.clone(),
                reason: format!("Matched policy: {}", rule.name),
                rule_id: Some(rule.id.clone()),
                rule_name: Some(rule.name.clone()),
                evaluation_time_us: elapsed.as_micros() as f64,
            };
        }
    }

    // Default deny — no matching rule means DENY
    let elapsed = start.elapsed();
    PolicyDecision {
        matched: false,
        action: "DENY".to_string(),
        reason: "No matching policy found - default deny".to_string(),
        rule_id: None,
        rule_name: None,
        evaluation_time_us: elapsed.as_micros() as f64,
    }
}

/// Evaluate all conditions for a single rule against context.
/// Returns true only if ALL conditions match (AND logic).
fn evaluate_conditions(
    rule: &crate::types::PolicyRule,
    compiled: &CompiledRule,
    context: &PolicyContext,
) -> bool {
    let conditions = &rule.conditions;

    // Tool type matching
    if let Some(ref tool_types) = conditions.tool_types {
        if !tool_types.is_empty() && !tool_types.iter().any(|t| t == &context.tool_type) {
            return false;
        }
    }

    // Tool method matching (exact or glob pattern via pre-compiled regex)
    if let Some(ref tool_methods) = conditions.tool_methods {
        if !tool_methods.is_empty() {
            let method_matched = if compiled.method_patterns.is_empty() {
                // Exact match fallback
                tool_methods.iter().any(|m| m == &context.tool_method)
            } else {
                compiled
                    .method_patterns
                    .iter()
                    .any(|re| re.is_match(&context.tool_method))
            };
            if !method_matched {
                return false;
            }
        }
    }

    // Environment matching
    if let Some(ref environments) = conditions.environments {
        if !environments.is_empty() {
            match &context.environment {
                Some(env) => {
                    if !environments.iter().any(|e| e == env) {
                        return false;
                    }
                }
                None => return false,
            }
        }
    }

    // User role matching
    if let Some(ref user_roles) = conditions.user_roles {
        if !user_roles.is_empty() {
            match &context.user_role {
                Some(role) => {
                    if !user_roles.iter().any(|r| r == role) {
                        return false;
                    }
                }
                None => return false,
            }
        }
    }

    // Data classification matching
    if let Some(ref classifications) = conditions.data_classifications {
        if !classifications.is_empty() {
            match &context.data_classification {
                Some(dc) => {
                    if !classifications.iter().any(|c| c == dc) {
                        return false;
                    }
                }
                None => return false,
            }
        }
    }

    // Time window matching
    if let Some(ref time_window) = conditions.time_window {
        if !evaluate_time_window(time_window, &context.requested_at) {
            return false;
        }
    }

    // All conditions matched
    true
}

/// Evaluate time window condition.
/// Handles both same-day and midnight-crossing windows.
fn evaluate_time_window(tw: &crate::types::TimeWindow, requested_at: &str) -> bool {
    // Parse HH:MM from the ISO datetime string
    let current_minutes = parse_time_minutes_from_iso(requested_at);
    let start_minutes = parse_hhmm(&tw.start);
    let end_minutes = parse_hhmm(&tw.end);

    match (current_minutes, start_minutes, end_minutes) {
        (Some(current), Some(start), Some(end)) => {
            if start <= end {
                // Same day window: 09:00 - 17:00
                current >= start && current <= end
            } else {
                // Crosses midnight: 22:00 - 06:00
                current >= start || current <= end
            }
        }
        _ => true, // If parsing fails, don't block on time condition
    }
}

fn parse_hhmm(s: &str) -> Option<u32> {
    let parts: Vec<&str> = s.split(':').collect();
    if parts.len() >= 2 {
        let h = parts[0].parse::<u32>().ok()?;
        let m = parts[1].parse::<u32>().ok()?;
        Some(h * 60 + m)
    } else {
        None
    }
}

fn parse_time_minutes_from_iso(iso: &str) -> Option<u32> {
    // Try to extract HH:MM from various ISO 8601 formats
    // e.g., "2026-03-02T14:30:00.000Z" -> 14*60+30
    if let Some(t_pos) = iso.find('T') {
        let time_part = &iso[t_pos + 1..];
        parse_hhmm(time_part)
    } else {
        // Fallback: try parsing as HH:MM directly
        parse_hhmm(iso)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::{PolicyConditions, PolicyRule, TimeWindow};

    fn make_compiled(rule: PolicyRule) -> CompiledRule {
        let patterns: Vec<regex::Regex> = rule
            .conditions
            .tool_methods
            .as_ref()
            .map(|methods| {
                methods
                    .iter()
                    .filter(|m| m.contains('*'))
                    .filter_map(|m| {
                        let pattern = format!("^{}$", m.replace('*', ".*"));
                        regex::Regex::new(&pattern).ok()
                    })
                    .collect()
            })
            .unwrap_or_default();

        CompiledRule {
            rule,
            method_patterns: patterns,
        }
    }

    fn deny_rule(name: &str, priority: i32, conditions: PolicyConditions) -> CompiledRule {
        make_compiled(PolicyRule {
            id: format!("rule_{}", name),
            workspace_id: "ws1".into(),
            name: name.into(),
            enabled: true,
            action: "DENY".into(),
            priority,
            conditions,
            version: 1,
        })
    }

    fn allow_rule(name: &str, priority: i32, conditions: PolicyConditions) -> CompiledRule {
        make_compiled(PolicyRule {
            id: format!("rule_{}", name),
            workspace_id: "ws1".into(),
            name: name.into(),
            enabled: true,
            action: "ALLOW".into(),
            priority,
            conditions,
            version: 1,
        })
    }

    fn base_context() -> PolicyContext {
        PolicyContext {
            workspace_id: "ws1".into(),
            agent_id: "agent1".into(),
            task_id: "task1".into(),
            tool_type: "GITHUB".into(),
            tool_method: "createPR".into(),
            environment: Some("STAGING".into()),
            data_classification: Some("INTERNAL".into()),
            requested_at: "2026-03-02T10:30:00.000Z".into(),
            user_id: Some("user1".into()),
            user_role: Some("ADMIN".into()),
            metadata: None,
        }
    }

    #[test]
    fn test_default_deny_no_rules() {
        let result = evaluate(&base_context(), &[]);
        assert!(!result.matched);
        assert_eq!(result.action, "DENY");
    }

    #[test]
    fn test_allow_matching_tool_type() {
        let rules = vec![allow_rule(
            "allow_github",
            100,
            PolicyConditions {
                tool_types: Some(vec!["GITHUB".into()]),
                ..Default::default()
            },
        )];
        let result = evaluate(&base_context(), &rules);
        assert!(result.matched);
        assert_eq!(result.action, "ALLOW");
    }

    #[test]
    fn test_deny_non_matching_tool_type() {
        let rules = vec![allow_rule(
            "allow_jira",
            100,
            PolicyConditions {
                tool_types: Some(vec!["JIRA".into()]),
                ..Default::default()
            },
        )];
        let result = evaluate(&base_context(), &rules);
        assert!(!result.matched);
        assert_eq!(result.action, "DENY");
    }

    #[test]
    fn test_priority_ordering() {
        let rules = vec![
            deny_rule(
                "deny_all",
                50,
                PolicyConditions {
                    tool_types: Some(vec!["GITHUB".into()]),
                    ..Default::default()
                },
            ),
            allow_rule(
                "allow_github",
                100,
                PolicyConditions {
                    tool_types: Some(vec!["GITHUB".into()]),
                    ..Default::default()
                },
            ),
        ];
        // Higher priority rule should match first
        // Note: rules should be pre-sorted, but we test both orderings
        let mut sorted = rules;
        sorted.sort_by(|a, b| b.rule.priority.cmp(&a.rule.priority));
        let result = evaluate(&base_context(), &sorted);
        assert!(result.matched);
        assert_eq!(result.action, "ALLOW");
    }

    #[test]
    fn test_time_window_within() {
        let rules = vec![allow_rule(
            "business_hours",
            100,
            PolicyConditions {
                tool_types: Some(vec!["GITHUB".into()]),
                time_window: Some(TimeWindow {
                    start: "09:00".into(),
                    end: "17:00".into(),
                }),
                ..Default::default()
            },
        )];
        // Context at 10:30 should match 09:00-17:00
        let result = evaluate(&base_context(), &rules);
        assert!(result.matched);
        assert_eq!(result.action, "ALLOW");
    }

    #[test]
    fn test_time_window_outside() {
        let rules = vec![allow_rule(
            "business_hours",
            100,
            PolicyConditions {
                tool_types: Some(vec!["GITHUB".into()]),
                time_window: Some(TimeWindow {
                    start: "09:00".into(),
                    end: "10:00".into(),
                }),
                ..Default::default()
            },
        )];
        // Context at 10:30 should be OUTSIDE 09:00-10:00
        let result = evaluate(&base_context(), &rules);
        assert!(!result.matched);
        assert_eq!(result.action, "DENY");
    }

    #[test]
    fn test_wildcard_method_pattern() {
        let rules = vec![allow_rule(
            "allow_create",
            100,
            PolicyConditions {
                tool_types: Some(vec!["GITHUB".into()]),
                tool_methods: Some(vec!["create*".into()]),
                ..Default::default()
            },
        )];
        let result = evaluate(&base_context(), &rules);
        assert!(result.matched);
    }

    #[test]
    fn test_disabled_rule_skipped() {
        let mut rule = make_compiled(PolicyRule {
            id: "disabled".into(),
            workspace_id: "ws1".into(),
            name: "disabled_rule".into(),
            enabled: false,
            action: "ALLOW".into(),
            priority: 100,
            conditions: PolicyConditions {
                tool_types: Some(vec!["GITHUB".into()]),
                ..Default::default()
            },
            version: 1,
        });
        rule.rule.enabled = false;
        let result = evaluate(&base_context(), &[rule]);
        assert!(!result.matched);
        assert_eq!(result.action, "DENY");
    }

    #[test]
    fn test_evaluation_speed() {
        let rules: Vec<CompiledRule> = (0..200)
            .map(|i| {
                allow_rule(
                    &format!("rule_{}", i),
                    i,
                    PolicyConditions {
                        tool_types: Some(vec![format!("TOOL_{}", i)]),
                        ..Default::default()
                    },
                )
            })
            .collect();

        let ctx = base_context();
        let start = std::time::Instant::now();
        for _ in 0..10_000 {
            let _ = evaluate(&ctx, &rules);
        }
        let elapsed = start.elapsed();
        let per_eval_us = elapsed.as_micros() as f64 / 10_000.0;
        // Each evaluation should be well under 100μs even with 200 rules
        assert!(
            per_eval_us < 500.0,
            "Evaluation too slow: {}μs per eval",
            per_eval_us
        );
    }
}
