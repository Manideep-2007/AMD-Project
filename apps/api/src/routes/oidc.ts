/**
 * OIDC / OAuth2 SSO Routes
 *
 * Implements the authorization code flow for enterprise SSO.
 * Currently supports: Google (OIDC), GitHub (OAuth2)
 *
 * Flow:
 *   1. GET  /api/v1/auth/oidc/:provider/authorize  → redirect to provider
 *   2. GET  /api/v1/auth/oidc/:provider/callback   → exchange code, upsert user,
 *                                                    issue NexusOps tokens
 *
 * Required environment variables:
 *   GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET
 *   GITHUB_CLIENT_ID, GITHUB_CLIENT_SECRET
 *   OIDC_REDIRECT_BASE_URL  (e.g. https://api.nexusops.io)
 *   FRONTEND_URL            (e.g. https://app.nexusops.io)
 *
 * Security properties:
 *   - CSRF: state parameter is HMAC-SHA256 signed + has a 5-minute expiry
 *   - Refresh token is set as httpOnly / sameSite=strict cookie
 *   - Access token is passed to FE only via a short-lived one-time code
 *     (redirected to FRONTEND_URL/auth/callback?ot=<code>, then exchanged)
 */

import { FastifyPluginAsync } from 'fastify';
import { createHmac, randomBytes } from 'node:crypto';
import { prisma, UserRole } from '@nexusops/db';
import { createLogger } from '@nexusops/logger';

const logger = createLogger('auth:oidc');

// ─── Provider configuration ──────────────────────────────────────────────────

interface OIDCProvider {
  authorizeUrl: string;
  tokenUrl: string;
  userinfoUrl: string | null; // null for GitHub (separate /user endpoint)
  scopes: string[];
  clientIdEnv: string;
  clientSecretEnv: string;
}

const PROVIDERS: Record<string, OIDCProvider> = {
  google: {
    authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    userinfoUrl: 'https://www.googleapis.com/oauth2/v3/userinfo',
    scopes: ['openid', 'email', 'profile'],
    clientIdEnv: 'GOOGLE_CLIENT_ID',
    clientSecretEnv: 'GOOGLE_CLIENT_SECRET',
  },
  github: {
    authorizeUrl: 'https://github.com/login/oauth/authorize',
    tokenUrl: 'https://github.com/login/oauth/access_token',
    userinfoUrl: 'https://api.github.com/user',
    scopes: ['read:user', 'user:email'],
    clientIdEnv: 'GITHUB_CLIENT_ID',
    clientSecretEnv: 'GITHUB_CLIENT_SECRET',
  },
};

// ─── State helpers (CSRF protection) ─────────────────────────────────────────

/** Signs a random state token with HMAC so it cannot be forged. */
function createState(secret: string): string {
  const nonce = randomBytes(16).toString('hex');
  const ts = Date.now().toString(36);
  const payload = `${nonce}.${ts}`;
  const sig = createHmac('sha256', secret).update(payload).digest('hex').slice(0, 16);
  return `${payload}.${sig}`;
}

/** Returns true if the state signature is valid and not older than 5 minutes. */
function verifyState(state: string, secret: string): boolean {
  const parts = state.split('.');
  if (parts.length !== 3) return false;
  const [nonce, ts, sig] = parts;
  const payload = `${nonce}.${ts}`;
  const expectedSig = createHmac('sha256', secret).update(payload).digest('hex').slice(0, 16);
  if (sig !== expectedSig) return false;
  const age = Date.now() - parseInt(ts, 36);
  return age < 5 * 60 * 1000; // 5 minutes
}

// ─── Token exchange helpers ───────────────────────────────────────────────────

async function exchangeCode(
  provider: OIDCProvider,
  code: string,
  redirectUri: string,
  clientId: string,
  clientSecret: string,
): Promise<{ accessToken: string; idToken?: string }> {
  const params = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri,
    client_id: clientId,
    client_secret: clientSecret,
  });

  const res = await fetch(provider.tokenUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    },
    body: params.toString(),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Token exchange failed (${res.status}): ${text}`);
  }

  const json = await res.json() as Record<string, string>;
  return { accessToken: json.access_token, idToken: json.id_token };
}

interface ProviderProfile {
  sub: string;
  email: string;
  name?: string;
  picture?: string;
  emailVerified?: boolean;
}

async function fetchProfile(
  provider: OIDCProvider,
  accessToken: string,
): Promise<ProviderProfile> {
  if (!provider.userinfoUrl) throw new Error('No userinfo URL configured');

  const res = await fetch(provider.userinfoUrl, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: 'application/json',
      // GitHub API requires a User-Agent header
      'User-Agent': 'NexusOps/1.0',
    },
  });

  if (!res.ok) {
    throw new Error(`Userinfo fetch failed (${res.status})`);
  }

  const json = await res.json() as Record<string, unknown>;

  // GitHub returns 'id' (number) while Google returns 'sub' (string)
  const sub = String(json.sub ?? json.id ?? '');
  const email = String(json.email ?? '');

  // GitHub primary email may not be included in /user; handle gracefully
  if (!email) {
    throw new Error('Provider did not return an email address. '
      + 'For GitHub, ensure the user has a public primary email or grant user:email scope.');
  }

  return {
    sub,
    email,
    name: String(json.name ?? json.login ?? ''),
    picture: String(json.avatar_url ?? json.picture ?? ''),
    emailVerified: Boolean(json.email_verified ?? true),
  };
}

// ─── One-time-code store (Redis-backed, 60-second TTL) ───────────────────────
// The OTC lets us avoid putting the access token in the redirect query string
// for providers where that would be visible in server access logs.
// The frontend exchanges the OTC at POST /auth/oidc/token for the access token.

let redis: { set: (...a: any[]) => any; get: (...a: any[]) => any; del: (...a: any[]) => any } | null = null;
try {
  if (process.env.REDIS_URL) {
    const Redis = require('ioredis');
    redis = new Redis(process.env.REDIS_URL, { maxRetriesPerRequest: 1, lazyConnect: true });
    (redis as any).connect().catch(() => { redis = null; });
  }
} catch { /* Redis unavailable — fall back to in-memory */ }

// In-memory fallback (single instance; fine for small deploys)
const memOTCStore = new Map<string, { accessToken: string; expiresAt: number }>();

async function storeOTC(code: string, accessToken: string): Promise<void> {
  const ttl = 60; // 60 seconds
  if (redis) {
    await redis.set(`otc:${code}`, accessToken, 'EX', ttl);
  } else {
    memOTCStore.set(code, { accessToken, expiresAt: Date.now() + ttl * 1000 });
  }
}

async function consumeOTC(code: string): Promise<string | null> {
  if (redis) {
    const token = await redis.get(`otc:${code}`);
    if (token) await redis.del(`otc:${code}`);
    return token ?? null;
  }
  const entry = memOTCStore.get(code);
  if (!entry) return null;
  memOTCStore.delete(code);
  if (Date.now() > entry.expiresAt) return null;
  return entry.accessToken;
}

// ─── Route plugin ─────────────────────────────────────────────────────────────

export const oidcRoutes: FastifyPluginAsync = async (app) => {
  const jwtSecret = process.env.JWT_SECRET!;
  const redirectBase = (process.env.OIDC_REDIRECT_BASE_URL ?? 'http://localhost:3001').replace(/\/$/, '');
  const frontendUrl = (process.env.FRONTEND_URL ?? 'http://localhost:3000').replace(/\/$/, '');

  /**
   * GET /api/v1/auth/oidc/:provider/authorize
   * Redirects the user to the OAuth2/OIDC provider consent screen.
   */
  app.get<{ Params: { provider: string } }>('/:provider/authorize', async (request, reply) => {
    const { provider: providerName } = request.params;
    const config = PROVIDERS[providerName];

    if (!config) {
      return reply.code(400).send({ error: `Unknown provider: ${providerName}` });
    }

    const clientId = process.env[config.clientIdEnv];
    if (!clientId) {
      logger.error({ provider: providerName }, 'OIDC client ID not configured');
      return reply.code(503).send({ error: `${providerName} SSO is not configured on this server.` });
    }

    const state = createState(jwtSecret);
    const redirectUri = `${redirectBase}/api/v1/auth/oidc/${providerName}/callback`;

    const params = new URLSearchParams({
      response_type: 'code',
      client_id: clientId,
      redirect_uri: redirectUri,
      scope: config.scopes.join(' '),
      state,
      // Google-specific: force account selection
      ...(providerName === 'google' ? { prompt: 'select_account', access_type: 'offline' } : {}),
    });

    return reply.redirect(`${config.authorizeUrl}?${params.toString()}`);
  });

  /**
   * GET /api/v1/auth/oidc/:provider/callback
   * Handles the authorization code callback from the provider.
   * Upserts the user, issues NexusOps tokens, and redirects to the frontend.
   */
  app.get<{
    Params: { provider: string };
    Querystring: { code?: string; state?: string; error?: string };
  }>('/:provider/callback', async (request, reply) => {
    const { provider: providerName } = request.params;
    const { code, state, error: providerError } = request.query;

    // Surface provider-level errors (e.g. user denied access)
    if (providerError) {
      logger.warn({ provider: providerName, providerError }, 'Provider returned error on OIDC callback');
      return reply.redirect(`${frontendUrl}/login?error=oidc_denied`);
    }

    // Validate state (CSRF guard)
    if (!state || !verifyState(state, jwtSecret)) {
      logger.warn({ provider: providerName }, 'OIDC callback: invalid or expired state parameter');
      return reply.redirect(`${frontendUrl}/login?error=oidc_state_mismatch`);
    }

    if (!code) {
      return reply.redirect(`${frontendUrl}/login?error=oidc_no_code`);
    }

    const config = PROVIDERS[providerName];
    if (!config) {
      return reply.redirect(`${frontendUrl}/login?error=oidc_unknown_provider`);
    }

    const clientId = process.env[config.clientIdEnv];
    const clientSecret = process.env[config.clientSecretEnv];
    if (!clientId || !clientSecret) {
      return reply.redirect(`${frontendUrl}/login?error=oidc_not_configured`);
    }

    try {
      const redirectUri = `${redirectBase}/api/v1/auth/oidc/${providerName}/callback`;

      // Exchange code for provider access token
      const { accessToken: providerAccessToken } = await exchangeCode(
        config, code, redirectUri, clientId, clientSecret,
      );

      // Fetch user profile from provider
      const profile = await fetchProfile(config, providerAccessToken);

      if (!profile.email) {
        return reply.redirect(`${frontendUrl}/login?error=oidc_no_email`);
      }

      // ── Upsert user & oauth_account ──────────────────────────────────────
      const user = await prisma.$transaction(async (tx) => {
        // Try to find existing oauth account first
        const existingOAuth = await (tx as any).oAuthAccount.findUnique({
          where: {
            provider_providerAccountId: {
              provider: providerName,
              providerAccountId: profile.sub,
            },
          },
          include: { user: true },
        });

        if (existingOAuth) {
          // Update last login
          await tx.user.update({
            where: { id: existingOAuth.userId },
            data: { lastLoginAt: new Date() },
          });
          return existingOAuth.user;
        }

        // Check if a user with this email already exists (merge accounts)
        let existingUser = await tx.user.findUnique({
          where: { email: profile.email },
        });

        if (!existingUser) {
          // Create a new user (no workspace yet — prompt in FE onboarding)
          // Cast: passwordHash is nullable after migration 20260306000002; Prisma
          // client types will reflect this once `prisma generate` is re-run.
          const created = await (tx.user.create as any)({
            data: {
              email: profile.email,
              name: profile.name ?? null,
              avatarUrl: profile.picture ?? null,
              emailVerified: profile.emailVerified ?? true,
              passwordHash: null, // OIDC-only user — no local password
            },
          });
          existingUser = created;
        }

        // TypeScript guard: existingUser is guaranteed non-null at this point
        if (!existingUser) throw new Error('User creation failed unexpectedly');

        // Link the oauth account
        await (tx as any).oAuthAccount.create({
          data: {
            userId: existingUser.id,
            provider: providerName,
            providerAccountId: profile.sub,
            email: profile.email,
          },
        });

        await tx.user.update({
          where: { id: existingUser.id },
          data: { lastLoginAt: new Date() },
        });

        return existingUser;
      });

      // ── Resolve workspace ─────────────────────────────────────────────────
      const userWorkspace = await prisma.workspaceUser.findFirst({
        where: { userId: user.id },
        include: { workspace: true },
        orderBy: { workspace: { createdAt: 'asc' } },
      });

      // Users with no workspace are directed to onboarding
      const workspaceId = userWorkspace?.workspaceId ?? null;
      const role = userWorkspace?.role ?? UserRole.VIEWER;

      // ── Issue NexusOps tokens ─────────────────────────────────────────────
      const accessToken = app.jwt.sign({
        userId: user.id,
        workspaceId,
        role,
        type: 'access',
      });

      const refreshToken = app.jwt.sign(
        { userId: user.id, workspaceId, role, type: 'refresh' },
        { expiresIn: process.env.JWT_REFRESH_EXPIRY ?? '7d' },
      );

      const { createHash } = await import('node:crypto');
      await prisma.refreshToken.create({
        data: {
          userId: user.id,
          token: createHash('sha256').update(refreshToken).digest('hex'),
          expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
        },
      });

      // Set refresh token as httpOnly cookie
      reply.setCookie('refresh_token', refreshToken, {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'strict',
        path: '/api/v1/auth',
        maxAge: 7 * 24 * 60 * 60,
      });

      // ── One-time code for the frontend to exchange ────────────────────────
      // Avoids putting the access token directly in the redirect URL query string.
      const otCode = randomBytes(24).toString('hex');
      await storeOTC(otCode, accessToken);

      const redirectTo = userWorkspace
        ? `${frontendUrl}/auth/callback?ot=${otCode}`
        : `${frontendUrl}/onboarding?ot=${otCode}`;

      logger.info({ userId: user.id, provider: providerName }, 'OIDC login successful');
      return reply.redirect(redirectTo);
    } catch (err) {
      logger.error({ err, provider: providerName }, 'OIDC callback error');
      return reply.redirect(`${frontendUrl}/login?error=oidc_server_error`);
    }
  });

  /**
   * POST /api/v1/auth/oidc/token
   * Exchanges the one-time code (returned by the callback redirect) for the
   * actual NexusOps access token.
   *
   * Body: { code: string }
   * Returns: { accessToken: string }
   */
  app.post<{ Body: { code?: string } }>('/token', async (request, reply) => {
    const { code } = request.body ?? {};
    if (!code || typeof code !== 'string') {
      return reply.code(400).send({ error: 'code is required' });
    }

    const accessToken = await consumeOTC(code);
    if (!accessToken) {
      return reply.code(401).send({ error: 'Invalid or expired one-time code' });
    }

    return {
      data: { accessToken },
      meta: { requestId: request.id, timestamp: new Date().toISOString() },
      error: null,
    };
  });
};
