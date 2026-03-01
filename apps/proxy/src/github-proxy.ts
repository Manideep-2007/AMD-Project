import { Octokit } from '@octokit/rest';
import { createLogger } from '@nexusops/logger';
import type { ToolCallRequest, ToolCallResponse } from '@nexusops/types';

const logger = createLogger('proxy:github');

/**
 * GitHub Proxy
 * Allowed operations: read repo, create PR, comment on issue
 * Blocked: direct push to main, delete operations
 */
export class GitHubProxy {
  private octokit: Octokit;

  constructor(token: string) {
    this.octokit = new Octokit({ auth: token });
  }

  /**
   * Proxy a GitHub API call
   */
  async call(request: ToolCallRequest): Promise<ToolCallResponse> {
    const startTime = Date.now();

    try {
      logger.info({ method: request.toolMethod }, 'GitHub proxy call');

      // Route to appropriate method
      switch (request.toolMethod) {
        case 'getRepo':
          return await this.getRepo(request.input);
        case 'createPR':
          return await this.createPR(request.input);
        case 'commentOnIssue':
          return await this.commentOnIssue(request.input);
        case 'listPRs':
          return await this.listPRs(request.input);
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
      logger.error({ error: error.message }, 'GitHub proxy error');

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

  private async getRepo(input: any): Promise<ToolCallResponse> {
    const startTime = Date.now();
    const { owner, repo } = input;

    const response = await this.octokit.repos.get({ owner, repo });

    return {
      success: true,
      output: response.data,
      durationMs: Date.now() - startTime,
    };
  }

  private async createPR(input: any): Promise<ToolCallResponse> {
    const startTime = Date.now();
    const { owner, repo, title, body, head, base } = input;

    // Block PRs directly to main (should go through policy)
    if (base === 'main' || base === 'master') {
      return {
        success: false,
        blocked: true,
        blockReason: 'Direct PRs to main branch require manual approval',
        durationMs: Date.now() - startTime,
      };
    }

    const response = await this.octokit.pulls.create({
      owner,
      repo,
      title,
      body,
      head,
      base,
    });

    return {
      success: true,
      output: response.data,
      durationMs: Date.now() - startTime,
    };
  }

  private async commentOnIssue(input: any): Promise<ToolCallResponse> {
    const startTime = Date.now();
    const { owner, repo, issue_number, body } = input;

    const response = await this.octokit.issues.createComment({
      owner,
      repo,
      issue_number,
      body,
    });

    return {
      success: true,
      output: response.data,
      durationMs: Date.now() - startTime,
    };
  }

  private async listPRs(input: any): Promise<ToolCallResponse> {
    const startTime = Date.now();
    const { owner, repo, state = 'open' } = input;

    const response = await this.octokit.pulls.list({
      owner,
      repo,
      state,
    });

    return {
      success: true,
      output: response.data,
      durationMs: Date.now() - startTime,
    };
  }
}
