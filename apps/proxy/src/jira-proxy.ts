import axios from 'axios';
import { createLogger } from '@nexusops/logger';
import type { ToolCallRequest, ToolCallResponse } from '@nexusops/types';

const logger = createLogger('proxy:jira');

/**
 * Jira Proxy
 * Allowed: read/create/update tickets
 * Blocked: bulk delete, admin operations
 */
export class JiraProxy {
  private baseUrl: string;
  private auth: { username: string; password: string };

  constructor(jiraUrl: string, email: string, apiToken: string) {
    this.baseUrl = jiraUrl;
    this.auth = { username: email, password: apiToken };
  }

  async call(request: ToolCallRequest): Promise<ToolCallResponse> {
    const startTime = Date.now();

    try {
      logger.info({ method: request.toolMethod }, 'Jira proxy call');

      switch (request.toolMethod) {
        case 'getIssue':
          return await this.getIssue(request.input);
        case 'createIssue':
          return await this.createIssue(request.input);
        case 'updateIssue':
          return await this.updateIssue(request.input);
        case 'searchIssues':
          return await this.searchIssues(request.input);
        case 'bulkDelete':
          return {
            success: false,
            blocked: true,
            blockReason: 'Bulk delete operations are not allowed',
            durationMs: Date.now() - startTime,
          };
        default:
          return {
            success: false,
            blocked: true,
            blockReason: `Method '${request.toolMethod}' not allowed`,
            durationMs: Date.now() - startTime,
            error: {
              message: 'Method not allowed',
              code: 'METHOD_NOT_ALLOWED',
            },
          };
      }
    } catch (error: any) {
      logger.error({ error: error.message }, 'Jira proxy error');

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

  private async getIssue(input: any): Promise<ToolCallResponse> {
    const startTime = Date.now();
    const { issueKey } = input;

    const response = await axios.get(`${this.baseUrl}/rest/api/3/issue/${issueKey}`, {
      auth: this.auth,
    });

    return {
      success: true,
      output: response.data,
      durationMs: Date.now() - startTime,
    };
  }

  private async createIssue(input: any): Promise<ToolCallResponse> {
    const startTime = Date.now();

    const response = await axios.post(
      `${this.baseUrl}/rest/api/3/issue`,
      input,
      { auth: this.auth }
    );

    return {
      success: true,
      output: response.data,
      durationMs: Date.now() - startTime,
    };
  }

  private async updateIssue(input: any): Promise<ToolCallResponse> {
    const startTime = Date.now();
    const { issueKey, ...updates } = input;

    await axios.put(
      `${this.baseUrl}/rest/api/3/issue/${issueKey}`,
      updates,
      { auth: this.auth }
    );

    return {
      success: true,
      output: { updated: true },
      durationMs: Date.now() - startTime,
    };
  }

  private async searchIssues(input: any): Promise<ToolCallResponse> {
    const startTime = Date.now();
    const { jql, maxResults = 50 } = input;

    const response = await axios.post(
      `${this.baseUrl}/rest/api/3/search`,
      { jql, maxResults },
      { auth: this.auth }
    );

    return {
      success: true,
      output: response.data,
      durationMs: Date.now() - startTime,
    };
  }
}
