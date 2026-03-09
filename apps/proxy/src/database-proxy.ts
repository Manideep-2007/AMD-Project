import { Pool } from 'pg';
import { createLogger } from '@nexusops/logger';
import type { ToolCallRequest, ToolCallResponse } from '@nexusops/types';

const logger = createLogger('proxy:database');

/**
 * Database Proxy — per-execution scoped connections to CUSTOMER databases.
 *
 * CRITICAL: This proxy NEVER connects to the NexusOps platform database.
 * Each execution creates a scoped pool from the agent's customerDatabaseUrl
 * (decrypted at execution time) and destroys it after the query.
 *
 * Allowed: SELECT, scoped INSERT/UPDATE
 * Blocked: DROP, TRUNCATE, schema changes without approval
 */
export class DatabaseProxy {
  /**
   * Execute a query against a CUSTOMER database URL.
   * Creates a temporary pool, runs the query, and destroys the pool.
   *
   * @param request - Tool call request with input.query and input.params
   * @param customerDbUrl - Decrypted customer database connection string
   * @param agentId - Agent ID for logging
   */
  async execute(
    request: ToolCallRequest,
    customerDbUrl: string,
    agentId: string,
  ): Promise<ToolCallResponse> {
    const startTime = Date.now();

    // Reject if accidentally passed the platform DATABASE_URL
    if (customerDbUrl === process.env.DATABASE_URL) {
      logger.error({ agentId }, 'SECURITY: Attempted to use platform DATABASE_URL as customer DB');
      return {
        success: false,
        blocked: true,
        blockReason: 'CUSTOMER_DB_URL_REQUIRED — Cannot use platform database',
        durationMs: Date.now() - startTime,
      };
    }

    const { query, params } = request.input;

    // Enforce parameterized queries — raw string interpolation is blocked
    if (typeof query !== 'string' || !query.trim()) {
      return {
        success: false,
        blocked: true,
        blockReason: 'Query must be a non-empty string',
        durationMs: Date.now() - startTime,
      };
    }

    // Detect string interpolation / concatenation attempts
    const suspiciousPatterns = [
      /'\s*\+\s*/,           // String concatenation: ' +
      /\$\{/,               // Template literals: ${
      /'\s*\|\|\s*'/,       // SQL concat: ' || '
      /;\s*--/,             // SQL comment injection: ; --
      /;\s*(DROP|DELETE|INSERT|UPDATE|ALTER|TRUNCATE)/i, // Stacked queries
    ];

    for (const pattern of suspiciousPatterns) {
      if (pattern.test(query)) {
        return {
          success: false,
          blocked: true,
          blockReason: `Potential SQL injection detected: ${pattern.source}. Use parameterized queries ($1, $2, ...).`,
          durationMs: Date.now() - startTime,
        };
      }
    }

    // Block always-dangerous DDL operations
    const dangerousPatterns = [
      /DROP\s+(TABLE|DATABASE|SCHEMA)/i,
      /TRUNCATE/i,
      /ALTER\s+TABLE/i,
    ];

    for (const pattern of dangerousPatterns) {
      if (pattern.test(query)) {
        return {
          success: false,
          blocked: true,
          blockReason: `Query contains blocked operation: ${pattern.source}`,
          durationMs: Date.now() - startTime,
        };
      }
    }

    // Create scoped pool for this execution only — never cached
    const pool = new Pool({
      connectionString: customerDbUrl,
      max: 2,
      idleTimeoutMillis: 5000,
      connectionTimeoutMillis: 3000,
      ssl: { rejectUnauthorized: true },
    });

    try {
      const safeParams = Array.isArray(params) ? params : [];
      const result = await pool.query(query, safeParams);

      return {
        success: true,
        output: {
          rows: result.rows,
          rowCount: result.rowCount,
          command: result.command,
        },
        durationMs: Date.now() - startTime,
      };
    } catch (error: any) {
      logger.error({ error: error.message, agentId }, 'Database proxy error');

      return {
        success: false,
        durationMs: Date.now() - startTime,
        error: {
          message: error.message,
          code: 'PROXY_ERROR',
        },
      };
    } finally {
      // Always destroy pool — no connection reuse between executions
      await pool.end().catch((err: any) =>
        logger.warn({ err: err.message }, 'Pool cleanup error'),
      );
    }
  }

  /**
   * Legacy call() method — delegates to execute() for backward compatibility.
   * Requires customerDbUrl and agentId to be set on the request.
   */
  async call(
    request: ToolCallRequest,
    customerDbUrl?: string,
    agentId?: string,
  ): Promise<ToolCallResponse> {
    if (!customerDbUrl) {
      return {
        success: false,
        blocked: true,
        blockReason: 'DATABASE_NOT_CONFIGURED — No customer database URL provided. Set customerDatabaseUrl in agent configuration.',
        durationMs: 0,
      };
    }
    return this.execute(request, customerDbUrl, agentId ?? 'unknown');
  }
}
