/**
 * @nexusops/crypto — Cryptographic functions with Rust NAPI acceleration.
 *
 * Tries to load the Rust policy-core native module for production-grade
 * SHA-3-256 hashing and Ed25519 signing. Falls back to pure Node.js
 * crypto implementations when the native module is not built.
 *
 * Functions:
 *   hashSha3(data)               → SHA-3-256 hex string
 *   signPayload(payload, sk)     → Ed25519 signature hex
 *   verifySignature(payload, sig, pk) → boolean
 *   generateKeypair()            → { publicKey, secretKey }
 */

import { createHash, createHmac, randomBytes } from 'node:crypto';

// ---------- Native NAPI bindings (optional) ----------

interface NativeBindings {
  hashSha3: (data: string) => string;
  signPayload: (payload: string, secretKey: string) => string;
  verifySignature: (payload: string, signature: string, publicKey: string) => boolean;
  generateKeypair: () => { publicKey: string; secretKey: string };
}

let native: NativeBindings | null = null;
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const mod = require('@nexusops/policy-core');
  native = mod as NativeBindings;
} catch {
  // Native Rust module not available — pure JS fallback will be used
  if (process.env.NODE_ENV === 'production') {
    console.error(
      '⛔ FATAL: @nexusops/policy-core native module not built. ' +
      'Production MUST use Rust Ed25519 — HMAC fallback is NOT secure. ' +
      'Run `cargo build --release` in apps/policy-core first.',
    );
    process.exit(1);
  } else {
    console.warn(
      '⚠️  [DEV ONLY] Rust crypto module not available — using HMAC-SHA256 fallback. ' +
      'Signatures are NOT Ed25519. Do NOT use in production.',
    );
  }
}

// ---------- Pure JS fallbacks ----------

function fallbackHashSha3(data: string): string {
  // Node.js crypto doesn't have SHA3-256 in all versions, use SHA-256 as
  // a compatible fallback. In production, the Rust module provides real SHA-3.
  try {
    return createHash('sha3-256').update(data, 'utf8').digest('hex');
  } catch {
    // If sha3-256 isn't available (very old Node), fall back to sha256 + HMAC tag
    return createHmac('sha256', 'nexusops-sha3-fallback').update(data, 'utf8').digest('hex');
  }
}

function fallbackSignPayload(payload: string, secretKey: string): string {
  // DEV ONLY: HMAC-SHA256 is NOT an Ed25519 signature. This provides a valid
  // stand-in for development testing. Production MUST use the Rust native module.
  // Note: secretKey is used as HMAC key; for dev verification, publicKey is used
  // (since in the fallback keypair they're both random hex strings).
  return createHmac('sha256', secretKey).update(payload, 'utf8').digest('hex');
}

function fallbackVerifySignature(payload: string, signature: string, publicKey: string): boolean {
  // DEV ONLY: Re-compute the HMAC-SHA256 with the publicKey as a symmetric key stand-in.
  // This is NOT Ed25519 — it provides tamper detection in dev but not real asymmetric security.
  // Production MUST use the Rust native module (enforced above).
  const expected = createHmac('sha256', publicKey).update(payload, 'utf8').digest('hex');
  return expected === signature;
}

function fallbackGenerateKeypair(): { publicKey: string; secretKey: string } {
  // DEV ONLY: HMAC is symmetric — sign (uses secretKey) and verify (uses publicKey)
  // must share the same key for round-trip consistency. We expose the same random
  // bytes as both fields so that verifySignature(payload, sig, kp.publicKey) works
  // with signatures produced by signPayload(payload, kp.secretKey).
  // Production uses real Ed25519 asymmetric keys via the Rust native module.
  const sharedKey = randomBytes(32).toString('hex');
  return { publicKey: sharedKey, secretKey: sharedKey };
}

export interface KeyPair {
  publicKey: string; // hex-encoded Ed25519 verifying key
  secretKey: string; // hex-encoded Ed25519 signing key
}

/**
 * SHA-3-256 hash of arbitrary string data.
 * Uses Rust NAPI when available, falls back to Node.js crypto.
 * @returns hex-encoded 32-byte hash
 */
export function hashSha3(data: string): string {
  return native ? native.hashSha3(data) : fallbackHashSha3(data);
}

/**
 * Sign a payload with an Ed25519 secret key.
 * Uses Rust NAPI when available, HMAC-SHA256 fallback for dev.
 * @param payload   - UTF-8 string to sign
 * @param secretKey - hex-encoded 32-byte signing key
 * @returns hex-encoded 64-byte signature
 */
export function signPayload(payload: string, secretKey: string): string {
  return native ? native.signPayload(payload, secretKey) : fallbackSignPayload(payload, secretKey);
}

/**
 * Verify an Ed25519 signature.
 * Uses Rust NAPI when available, always-true fallback for dev.
 * @returns true if signature is valid
 */
export function verifySignature(
  payload: string,
  signature: string,
  publicKey: string,
): boolean {
  return native ? native.verifySignature(payload, signature, publicKey) : fallbackVerifySignature(payload, signature, publicKey);
}

/**
 * Generate a new Ed25519 keypair for agent identity.
 * Uses Rust NAPI when available, random bytes fallback for dev.
 * @returns { publicKey: hex, secretKey: hex }
 */
export function generateKeypair(): KeyPair {
  return native ? native.generateKeypair() : fallbackGenerateKeypair();
}

/**
 * Build a deterministic content hash for a ComplianceArtifact.
 * Concatenates the 5 data components in canonical order and hashes with SHA-3-256.
 */
export function hashComplianceContent(parts: {
  userPrompt: string;
  reasoningChain: unknown;
  contextRefs: unknown;
  policyDecision: string;
  executionRecord: unknown;
}): string {
  const canonical = [
    parts.userPrompt,
    JSON.stringify(parts.reasoningChain ?? null),
    JSON.stringify(parts.contextRefs ?? null),
    parts.policyDecision,
    JSON.stringify(parts.executionRecord ?? null),
  ].join('|');

  return hashSha3(canonical);
}

/**
 * Compute audit event chain hash.
 * SHA-3( previousHash + ':' + contentString )
 */
export function chainHash(previousHash: string | null, contentString: string): string {
  const input = `${previousHash ?? 'GENESIS'}:${contentString}`;
  return hashSha3(input);
}

// Re-export DB URL encryption utilities
export { encryptDbUrl, decryptDbUrl } from './db-encryption';
