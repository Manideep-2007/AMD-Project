import { describe, it, expect } from 'vitest';
import {
  hashSha3,
  signPayload,
  verifySignature,
  generateKeypair,
  hashComplianceContent,
  chainHash,
} from './index';

describe('Crypto Module', () => {
  describe('hashSha3', () => {
    it('should return a hex-encoded hash', () => {
      const hash = hashSha3('hello world');
      expect(typeof hash).toBe('string');
      expect(hash).toMatch(/^[0-9a-f]{64}$/);
    });

    it('should be deterministic', () => {
      const h1 = hashSha3('test data');
      const h2 = hashSha3('test data');
      expect(h1).toBe(h2);
    });

    it('should produce different hashes for different inputs', () => {
      const h1 = hashSha3('input-a');
      const h2 = hashSha3('input-b');
      expect(h1).not.toBe(h2);
    });

    it('should handle empty string', () => {
      const hash = hashSha3('');
      expect(hash).toMatch(/^[0-9a-f]{64}$/);
    });

    it('should handle unicode', () => {
      const hash = hashSha3('日本語テスト');
      expect(hash).toMatch(/^[0-9a-f]{64}$/);
    });

    it('should handle large payloads', () => {
      const hash = hashSha3('x'.repeat(100_000));
      expect(hash).toMatch(/^[0-9a-f]{64}$/);
    });
  });

  describe('generateKeypair', () => {
    it('should return publicKey and secretKey', () => {
      const kp = generateKeypair();
      expect(kp).toHaveProperty('publicKey');
      expect(kp).toHaveProperty('secretKey');
      expect(typeof kp.publicKey).toBe('string');
      expect(typeof kp.secretKey).toBe('string');
    });

    it('should return hex-encoded keys', () => {
      const kp = generateKeypair();
      expect(kp.publicKey).toMatch(/^[0-9a-f]+$/);
      expect(kp.secretKey).toMatch(/^[0-9a-f]+$/);
    });

    it('should generate unique keypairs each call', () => {
      const kp1 = generateKeypair();
      const kp2 = generateKeypair();
      expect(kp1.publicKey).not.toBe(kp2.publicKey);
      expect(kp1.secretKey).not.toBe(kp2.secretKey);
    });
  });

  describe('signPayload + verifySignature', () => {
    it('should produce a hex signature', () => {
      const kp = generateKeypair();
      const sig = signPayload('test payload', kp.secretKey);
      expect(typeof sig).toBe('string');
      expect(sig).toMatch(/^[0-9a-f]+$/);
    });

    it('should produce deterministic signatures with same key', () => {
      const kp = generateKeypair();
      const sig1 = signPayload('test', kp.secretKey);
      const sig2 = signPayload('test', kp.secretKey);
      expect(sig1).toBe(sig2);
    });

    it('should produce different signatures with different keys', () => {
      const kp1 = generateKeypair();
      const kp2 = generateKeypair();
      const sig1 = signPayload('test', kp1.secretKey);
      const sig2 = signPayload('test', kp2.secretKey);
      expect(sig1).not.toBe(sig2);
    });

    it('should verify valid signature', () => {
      const kp = generateKeypair();
      const sig = signPayload('hello', kp.secretKey);
      const valid = verifySignature('hello', sig, kp.publicKey);
      expect(valid).toBe(true);
    });
  });

  describe('hashComplianceContent', () => {
    it('should produce deterministic hash for same content', () => {
      const parts = {
        userPrompt: 'Deploy to staging',
        reasoningChain: [{ step: 1, action: 'validate' }],
        contextRefs: { taskId: 't-1' },
        policyDecision: 'ALLOW',
        executionRecord: { status: 'success' },
      };

      const h1 = hashComplianceContent(parts);
      const h2 = hashComplianceContent(parts);
      expect(h1).toBe(h2);
    });

    it('should produce different hash for different content', () => {
      const parts1 = {
        userPrompt: 'Deploy to staging',
        reasoningChain: null,
        contextRefs: null,
        policyDecision: 'ALLOW',
        executionRecord: null,
      };

      const parts2 = {
        ...parts1,
        policyDecision: 'DENY',
      };

      expect(hashComplianceContent(parts1)).not.toBe(hashComplianceContent(parts2));
    });

    it('should handle null values', () => {
      const hash = hashComplianceContent({
        userPrompt: '',
        reasoningChain: null,
        contextRefs: null,
        policyDecision: '',
        executionRecord: null,
      });
      expect(hash).toMatch(/^[0-9a-f]{64}$/);
    });
  });

  describe('chainHash', () => {
    it('should produce deterministic chain hash', () => {
      const h1 = chainHash(null, 'genesis event');
      const h2 = chainHash(null, 'genesis event');
      expect(h1).toBe(h2);
    });

    it('should incorporate previous hash', () => {
      const genesis = chainHash(null, 'event-0');
      const second = chainHash(genesis, 'event-1');
      const altSecond = chainHash('different-hash', 'event-1');

      expect(second).not.toBe(altSecond);
    });

    it('should use GENESIS as anchor for null previous hash', () => {
      const withNull = chainHash(null, 'test');
      const withGenesis = hashSha3('GENESIS:test');
      expect(withNull).toBe(withGenesis);
    });

    it('should form a verifiable chain', () => {
      const events = ['create-agent', 'submit-task', 'execute-tool', 'complete-task'];
      const hashes: string[] = [];

      let prev: string | null = null;
      for (const evt of events) {
        const h = chainHash(prev, evt);
        hashes.push(h);
        prev = h;
      }

      // Verify chain: recompute from scratch
      let verifyPrev: string | null = null;
      for (let i = 0; i < events.length; i++) {
        const recomputed = chainHash(verifyPrev, events[i]);
        expect(recomputed).toBe(hashes[i]);
        verifyPrev = recomputed;
      }
    });
  });

  describe('performance', () => {
    it('should compute SHA-3 hash in under 1ms', () => {
      const data = 'benchmark payload';
      const iterations = 1000;
      const start = performance.now();

      for (let i = 0; i < iterations; i++) {
        hashSha3(data);
      }

      const elapsed = performance.now() - start;
      const perHash = elapsed / iterations;

      console.log(`SHA-3 hash: ${perHash.toFixed(3)}ms per hash`);
      expect(perHash).toBeLessThan(1);
    });

    it('should sign payload in under 1ms', () => {
      const kp = generateKeypair();
      const iterations = 500;
      const start = performance.now();

      for (let i = 0; i < iterations; i++) {
        signPayload('benchmark payload', kp.secretKey);
      }

      const elapsed = performance.now() - start;
      const perSign = elapsed / iterations;

      console.log(`Sign payload: ${perSign.toFixed(3)}ms per sign`);
      expect(perSign).toBeLessThan(1);
    });
  });
});
