import { Pool } from 'pg';
import { createLogger } from '@nexusops/logger';
import type { ToolCallRequest, ToolCallResponse } from '@nexusops/types';

const logger = createLogger('proxy:database');

/**
 * Database Proxy
 * Allowed: SELECT, scoped INSERT/UPDATE
 * Blocked: DROP, TRUNCATE, schema changes without approval
 */
export class DatabaseProxy {
  private pool: Pool;

  constructor(connectionString: string) {
    this.pool = new Pool({ connectionString });
  }

  async call(request: ToolCallRequest): Promise<ToolCallResponse> {
    const startTime = Date.now();

    try {
      logger.info({ method: request.toolMethod }, 'Database proxy call');

      const { query, params } = request.input;

      // Block dangerous operations
      const dangerousPatterns = [
        /DROP\s+(TABLE|DATABASE|SCHEMA)/i,
        /TRUNCATE/i,
        /ALTER\s+TABLE/i,
        /DELETE\s+FROM/i, // Require specific approval for DELETE
      ];

      for (const pattern of dangerousPatterns) {
        if (pattern.test(query as string)) {
          return {
            success: false,
            blocked: true,
            blockReason: `Query contains blocked operation: ${pattern.source}`,
            durationMs: Date.now() - startTime,
          };
        }
      }

      // Execute query
      const result = await this.pool.query(query as string, params as any[]);

      return {
        success: true,
        output: {
          rows: result.rows,
          rowCount: result.rowCount,
        },
        durationMs: Date.now() - startTime,
      };
    } catch (error: any) {
      logger.error({ error: error.message }, 'Database proxy error');

      return {
        success: false,
        durationMs: Date.now() - startTime,
        error: {
          message: error.message,
          code: 'PROXY_ERROR',
        },
      };
    }
  }

  async close() {
    await this.pool.end();
  }
}
