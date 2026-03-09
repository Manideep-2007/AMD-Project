import { GitHubProxy } from './github-proxy';
import { JiraProxy } from './jira-proxy';
import { DatabaseProxy } from './database-proxy';
import { CloudDeployProxy } from './cloud-deploy-proxy';
import { createLogger } from '@nexusops/logger';
import { ToolType } from '@nexusops/db';

const logger = createLogger('proxy');

/**
 * Tool Proxy Manager
 * Routes tool calls to appropriate proxy implementations
 */
export class ProxyManager {
  private githubProxy?: GitHubProxy;
  private jiraProxy?: JiraProxy;
  private databaseProxy: DatabaseProxy;
  private cloudDeployProxy: CloudDeployProxy;

  constructor() {
    // Initialize proxies with environment config
    if (process.env.GITHUB_TOKEN) {
      this.githubProxy = new GitHubProxy(process.env.GITHUB_TOKEN);
    }

    if (process.env.JIRA_URL && process.env.JIRA_EMAIL && process.env.JIRA_API_TOKEN) {
      this.jiraProxy = new JiraProxy(
        process.env.JIRA_URL,
        process.env.JIRA_EMAIL,
        process.env.JIRA_API_TOKEN
      );
    }

    // DatabaseProxy is a factory — NOT initialized with a global URL.
    // It creates per-execution connections from agent's customerDatabaseUrl.
    this.databaseProxy = new DatabaseProxy();

    this.cloudDeployProxy = new CloudDeployProxy();

    logger.info('Tool proxies initialized');
  }

  /**
   * Route a tool call to the appropriate proxy.
   * For DATABASE calls, customerDbUrl and agentId must be provided.
   */
  async route(toolType: string, request: any, customerDbUrl?: string, agentId?: string) {
    logger.info({ toolType, method: request.toolMethod }, 'Routing tool call');

    switch (toolType) {
      case 'GITHUB':
        if (!this.githubProxy) {
          throw new Error('GitHub proxy not configured');
        }
        return this.githubProxy.call(request);

      case 'JIRA':
        if (!this.jiraProxy) {
          throw new Error('Jira proxy not configured');
        }
        return this.jiraProxy.call(request);

      case 'DATABASE':
        return this.databaseProxy.call(request, customerDbUrl, agentId);

      case 'CLOUD_DEPLOY':
        return this.cloudDeployProxy.call(request);

      default:
        throw new Error(`Unknown tool type: ${toolType}`);
    }
  }

  async close() {
    // DatabaseProxy no longer holds a persistent pool
    logger.info('Tool proxies closed');
  }
}

// Export singleton
export const proxyManager = new ProxyManager();
