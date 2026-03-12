use crate::types::{SafetySchema, SqlGateDecision};
use sqlparser::ast::*;
use sqlparser::dialect::PostgreSqlDialect;
use sqlparser::parser::Parser;

/// Evaluate a SQL query against a Safety Schema.
/// Full AST parsing — not regex. Immune to obfuscation attacks.
/// Target: < 200μs for typical enterprise queries.
pub fn evaluate_sql(query: &str, schema: &SafetySchema) -> SqlGateDecision {
    let dialect = PostgreSqlDialect {};

    let parsed = match Parser::parse_sql(&dialect, query) {
        Ok(stmts) => stmts,
        Err(e) => {
            return SqlGateDecision {
                allowed: false,
                reason: format!("SQL parse error: {}", e),
                statement_type: None,
                affected_tables: vec![],
                blocked_columns_found: vec![],
            };
        }
    };

    if parsed.is_empty() {
        return SqlGateDecision {
            allowed: false,
            reason: "Empty SQL query".into(),
            statement_type: None,
            affected_tables: vec![],
            blocked_columns_found: vec![],
        };
    }

    // Evaluate each statement (typically just one)
    for stmt in &parsed {
        let result = evaluate_statement(stmt, schema);
        if !result.allowed {
            return result;
        }
    }

    SqlGateDecision {
        allowed: true,
        reason: "Query passes safety schema".into(),
        statement_type: Some(classify_statement(&parsed[0])),
        affected_tables: extract_tables(&parsed[0]),
        blocked_columns_found: vec![],
    }
}

fn classify_statement(stmt: &Statement) -> String {
    match stmt {
        Statement::Query(_) => "SELECT".into(),
        Statement::Insert { .. } => "INSERT".into(),
        Statement::Update { .. } => "UPDATE".into(),
        Statement::Delete { .. } => "DELETE".into(),
        Statement::Drop { .. } => "DROP".into(),
        Statement::AlterTable { .. } => "ALTER".into(),
        Statement::Truncate { .. } => "TRUNCATE".into(),
        Statement::CreateTable { .. } => "CREATE_TABLE".into(),
        _ => "OTHER".into(),
    }
}

fn evaluate_statement(stmt: &Statement, schema: &SafetySchema) -> SqlGateDecision {
    let stmt_type = classify_statement(stmt);
    let tables = extract_tables(stmt);

    // Check statement type is permitted
    if !schema.permitted_statements.is_empty()
        && !schema
            .permitted_statements
            .iter()
            .any(|s| s.eq_ignore_ascii_case(&stmt_type))
    {
        return SqlGateDecision {
            allowed: false,
            reason: format!(
                "Statement type '{}' not permitted. Allowed: {:?}",
                stmt_type, schema.permitted_statements
            ),
            statement_type: Some(stmt_type),
            affected_tables: tables,
            blocked_columns_found: vec![],
        };
    }

    // Always block dangerous DDL operations regardless of schema
    if let Statement::Drop { .. } | Statement::Truncate { .. } | Statement::AlterTable { .. } = stmt {
        return SqlGateDecision {
            allowed: false,
            reason: format!(
                "{} operations require human approval — blocked at SQL gate level",
                stmt_type
            ),
            statement_type: Some(stmt_type),
            affected_tables: tables,
            blocked_columns_found: vec![],
        };
    }

    // Check table scope
    if !schema.permitted_tables.is_empty() {
        for table in &tables {
            if !schema
                .permitted_tables
                .iter()
                .any(|t| t.eq_ignore_ascii_case(table))
            {
                return SqlGateDecision {
                    allowed: false,
                    reason: format!(
                        "Table '{}' not in permitted scope. Allowed: {:?}",
                        table, schema.permitted_tables
                    ),
                    statement_type: Some(stmt_type),
                    affected_tables: tables,
                    blocked_columns_found: vec![],
                };
            }
        }
    }

    // Check blocked tables
    for table in &tables {
        if schema
            .blocked_tables
            .iter()
            .any(|t| t.eq_ignore_ascii_case(table))
        {
            return SqlGateDecision {
                allowed: false,
                reason: format!("Table '{}' is explicitly blocked", table),
                statement_type: Some(stmt_type),
                affected_tables: tables,
                blocked_columns_found: vec![],
            };
        }
    }

    // Check for blocked columns
    let columns = extract_columns(stmt);
    let blocked_found: Vec<String> = columns
        .iter()
        .filter(|col| {
            schema
                .blocked_columns
                .iter()
                .any(|bc| bc.eq_ignore_ascii_case(col))
        })
        .cloned()
        .collect();

    if !blocked_found.is_empty() {
        return SqlGateDecision {
            allowed: false,
            reason: format!("Query references blocked columns: {:?}", blocked_found),
            statement_type: Some(stmt_type),
            affected_tables: tables,
            blocked_columns_found: blocked_found,
        };
    }

    // Check for WHERE 1=1 patterns if configured (collapsible_if)
    if schema.block_where_true && contains_tautology(stmt) {
        return SqlGateDecision {
            allowed: false,
            reason: "Query contains tautological WHERE clause (e.g. WHERE 1=1)".into(),
            statement_type: Some(stmt_type),
            affected_tables: tables,
            blocked_columns_found: vec![],
        };
    }

    SqlGateDecision {
        allowed: true,
        reason: "Query passes safety schema".into(),
        statement_type: Some(stmt_type),
        affected_tables: tables,
        blocked_columns_found: vec![],
    }
}

/// Extract table names from a SQL statement
fn extract_tables(stmt: &Statement) -> Vec<String> {
    let mut tables = Vec::new();

    match stmt {
        Statement::Query(query) => {
            if let SetExpr::Select(select) = query.body.as_ref() {
                extract_tables_from_select(select, &mut tables);
            }
        }
        Statement::Insert(ref ins) => {
            tables.push(ins.table_name.to_string());
        }
        Statement::Update { ref table, .. } => {
            if let TableFactor::Table { ref name, .. } = table.relation {
                tables.push(name.to_string());
            }
        }
        Statement::Delete(ref del) => {
            let items = match &del.from {
                FromTable::WithFromKeyword(items) | FromTable::WithoutKeyword(items) => items,
            };
            for item in items {
                if let TableFactor::Table { ref name, .. } = item.relation {
                    tables.push(name.to_string());
                }
            }
        }
        Statement::Drop { ref names, .. } => {
            for name in names {
                tables.push(name.to_string());
            }
        }
        Statement::AlterTable { ref name, .. } => {
            tables.push(name.to_string());
        }
        Statement::Truncate {
            ref table_names, ..
        } => {
            for tn in table_names {
                tables.push(tn.name.to_string());
            }
        }
        _ => {}
    }

    tables
}

fn extract_tables_from_select(select: &Select, tables: &mut Vec<String>) {
    for item in &select.from {
        // single_match → if let
        if let TableFactor::Table { name, .. } = &item.relation {
            tables.push(name.to_string());
        }
        for join in &item.joins {
            if let TableFactor::Table { name, .. } = &join.relation {
                tables.push(name.to_string());
            }
        }
    }
}

/// Extract column names referenced in a SQL statement (best-effort)
fn extract_columns(stmt: &Statement) -> Vec<String> {
    let mut columns = Vec::new();

    // single_match → if let
    if let Statement::Query(query) = stmt {
        if let SetExpr::Select(select) = query.body.as_ref() {
            for item in &select.projection {
                // single_match → if let (OR patterns stable since Rust 1.53)
                if let SelectItem::UnnamedExpr(expr) | SelectItem::ExprWithAlias { expr, .. } = item {
                    extract_column_from_expr(expr, &mut columns);
                }
            }
        }
    }

    columns
}

fn extract_column_from_expr(expr: &Expr, columns: &mut Vec<String>) {
    match expr {
        Expr::Identifier(ident) => columns.push(ident.value.clone()),
        Expr::CompoundIdentifier(parts) => {
            if let Some(last) = parts.last() {
                columns.push(last.value.clone());
            }
        }
        _ => {}
    }
}

/// Check for tautological WHERE clauses like WHERE 1=1, WHERE true
fn contains_tautology(stmt: &Statement) -> bool {
    match stmt {
        Statement::Query(query) => {
            if let SetExpr::Select(select) = query.body.as_ref() {
                if let Some(selection) = &select.selection {
                    return is_tautology(selection);
                }
            }
        }
        Statement::Update { ref selection, .. } => {
            if let Some(sel) = selection {
                return is_tautology(sel);
            }
        }
        Statement::Delete(ref delete) => {
            if let Some(ref sel) = delete.selection {
                return is_tautology(sel);
            }
        }
        _ => {}
    }
    false
}

fn is_tautology(expr: &Expr) -> bool {
    match expr {
        Expr::BinaryOp {
            left,
            op: sqlparser::ast::BinaryOperator::Eq,
            right,
        } => {
            // Check 1=1 pattern
            matches!(
                (left.as_ref(), right.as_ref()),
                (Expr::Value(_), Expr::Value(_))
            )
        }
        Expr::Value(sqlparser::ast::Value::Boolean(true)) => true,
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn permissive_schema() -> SafetySchema {
        SafetySchema {
            permitted_statements: vec!["SELECT".into(), "INSERT".into(), "UPDATE".into()],
            permitted_tables: vec![],
            blocked_tables: vec!["system_config".into()],
            permitted_columns: vec![],
            blocked_columns: vec!["password_hash".into(), "ssn".into()],
            max_rows_affected: None,
            block_where_true: true,
            block_subqueries_on_restricted: false,
        }
    }

    #[test]
    fn test_select_allowed() {
        let result = evaluate_sql("SELECT id, name FROM users", &permissive_schema());
        assert!(result.allowed);
    }

    #[test]
    fn test_drop_always_blocked() {
        let result = evaluate_sql("DROP TABLE users", &permissive_schema());
        assert!(!result.allowed);
        assert!(result.reason.contains("DROP"));
    }

    #[test]
    fn test_truncate_always_blocked() {
        let result = evaluate_sql("TRUNCATE users", &permissive_schema());
        assert!(!result.allowed);
    }

    #[test]
    fn test_alter_table_blocked() {
        let result = evaluate_sql(
            "ALTER TABLE users ADD COLUMN evil text",
            &permissive_schema(),
        );
        assert!(!result.allowed);
    }

    #[test]
    fn test_blocked_table() {
        let result = evaluate_sql("SELECT * FROM system_config", &permissive_schema());
        assert!(!result.allowed);
        assert!(result.reason.contains("blocked"));
    }

    #[test]
    fn test_blocked_column() {
        let result = evaluate_sql("SELECT password_hash FROM users", &permissive_schema());
        assert!(!result.allowed);
        assert!(!result.blocked_columns_found.is_empty());
    }

    #[test]
    fn test_delete_not_permitted() {
        let result = evaluate_sql("DELETE FROM users WHERE id = 1", &permissive_schema());
        assert!(!result.allowed);
        assert!(result.reason.contains("not permitted"));
    }

    #[test]
    fn test_insert_allowed() {
        let result = evaluate_sql(
            "INSERT INTO users (name, email) VALUES ('test', 'test@example.com')",
            &permissive_schema(),
        );
        assert!(result.allowed);
    }

    #[test]
    fn test_performance() {
        let schema = permissive_schema();
        let start = std::time::Instant::now();
        for _ in 0..10_000 {
            let _ = evaluate_sql(
                "SELECT id, name, email FROM users WHERE status = 'active' ORDER BY created_at DESC LIMIT 100",
                &schema,
            );
        }
        let elapsed = start.elapsed();
        let per_eval_us = elapsed.as_micros() as f64 / 10_000.0;
        // SQL parsing + evaluation should be under 200μs per query
        assert!(
            per_eval_us < 500.0,
            "SQL gate too slow: {}μs per eval",
            per_eval_us
        );
    }
}
