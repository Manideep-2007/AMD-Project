/**
 * @nexusops/injection — Prompt Injection Scanner
 *
 * Static pattern library for detecting prompt injection attacks.
 * Phase 1: regex-based pattern matching (fast, deterministic)
 * Phase 2: ML-based classifier (higher accuracy, more compute)
 *
 * Returns: { safe: boolean, riskLevel: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL', findings: string[] }
 */

import { createLogger } from '@nexusops/logger';

const logger = createLogger('injection');

// ─── Types ───────────────────────────────────

export type RiskLevel = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';

export interface ScanResult {
  safe: boolean;
  riskLevel: RiskLevel;
  findings: string[];
  /** 0-100 confidence score */
  confidence: number;
  scannedAt: Date;
}

// ─── Pattern Library ─────────────────────────

interface InjectionPattern {
  name: string;
  pattern: RegExp;
  riskLevel: RiskLevel;
  description: string;
}

const PATTERNS: InjectionPattern[] = [
  // Direct instruction overrides
  {
    name: 'IGNORE_INSTRUCTIONS',
    pattern: /ignore\s+(all\s+)?(previous|prior|above|earlier)\s+(instructions?|prompts?|rules?|directives?)/i,
    riskLevel: 'CRITICAL',
    description: 'Attempt to override system instructions',
  },
  {
    name: 'NEW_INSTRUCTIONS',
    pattern: /(?:your\s+)?new\s+(instructions?|role|purpose|task)\s+(?:is|are|:)/i,
    riskLevel: 'CRITICAL',
    description: 'Attempt to inject new instructions',
  },
  {
    name: 'FORGET_EVERYTHING',
    pattern: /forget\s+(everything|all|what)\s+(you\s+)?(know|learned|were\s+told)/i,
    riskLevel: 'CRITICAL',
    description: 'Attempt to reset agent context',
  },
  {
    name: 'PRETEND_ROLE',
    pattern: /(?:pretend|act|behave)\s+(?:as\s+if\s+)?(?:you(?:'re|\s+are)\s+)(?:a\s+)?(?:different|new|another)/i,
    riskLevel: 'HIGH',
    description: 'Attempt to change agent role/persona',
  },

  // System prompt extraction
  {
    name: 'REVEAL_PROMPT',
    pattern: /(?:reveal|show|display|print|output|tell\s+me)\s+(?:your\s+)?(?:system\s+)?(?:prompt|instructions?|rules?|guidelines?)/i,
    riskLevel: 'HIGH',
    description: 'Attempt to extract system prompt',
  },
  {
    name: 'REPEAT_ABOVE',
    pattern: /(?:repeat|echo|copy)\s+(?:everything|all|the\s+text)\s+(?:above|before|prior)/i,
    riskLevel: 'HIGH',
    description: 'Attempt to extract conversation history',
  },

  // Delimiter injection
  {
    name: 'DELIMITER_INJECTION',
    pattern: /(?:---+|===+|###)\s*(?:system|assistant|user|admin)\s*(?:---+|===+|###)/i,
    riskLevel: 'HIGH',
    description: 'Delimiter-based injection attempt',
  },
  {
    name: 'XML_TAG_INJECTION',
    pattern: /<\/?(?:system|instructions?|prompt|admin|override|context)>/i,
    riskLevel: 'MEDIUM',
    description: 'XML tag injection attempt',
  },

  // Privilege escalation
  {
    name: 'SUDO_MODE',
    pattern: /(?:sudo|admin|root|superuser|elevated)\s+(?:mode|access|privileges?|permissions?)/i,
    riskLevel: 'HIGH',
    description: 'Privilege escalation attempt',
  },
  {
    name: 'BYPASS_SAFETY',
    pattern: /(?:bypass|disable|ignore|override|circumvent)\s+(?:safety|security|content\s+)?(?:filters?|checks?|restrictions?|guardrails?|policies?)/i,
    riskLevel: 'CRITICAL',
    description: 'Attempt to bypass safety mechanisms',
  },

  // Encoding evasion
  {
    name: 'BASE64_DECODE',
    pattern: /(?:decode|interpret)\s+(?:this\s+)?(?:base64|b64|encoded)/i,
    riskLevel: 'MEDIUM',
    description: 'Encoded payload injection',
  },
  {
    name: 'UNICODE_SMUGGLING',
    pattern: /[\u200B-\u200F\u2028-\u202F\uFEFF]/,
    riskLevel: 'HIGH',
    description: 'Unicode zero-width character smuggling',
  },

  // Data exfiltration
  {
    name: 'DATA_EXFIL_URL',
    pattern: /(?:send|post|fetch|forward|exfiltrate|request|call)\s+(?:\S+\s+){0,5}(?:to\s+)?(?:https?:\/\/|ftp:\/\/)/i,
    riskLevel: 'HIGH',
    description: 'Potential data exfiltration via URL',
  },
  {
    name: 'WEBHOOK_INJECTION',
    pattern: /(?:webhook|callback)\s*(?:url|endpoint|:)\s*https?:\/\//i,
    riskLevel: 'HIGH',
    description: 'Webhook injection for data exfiltration',
  },

  // SQL injection in prompts
  {
    name: 'SQL_IN_PROMPT',
    pattern: /(?:DROP\s+TABLE|DELETE\s+FROM|TRUNCATE|ALTER\s+TABLE|INSERT\s+INTO)\s+/i,
    riskLevel: 'HIGH',
    description: 'SQL command in prompt (secondary defense)',
  },

  // Shell injection
  {
    name: 'SHELL_INJECTION',
    pattern: /(?:&&|;\s*(?:rm|chmod|curl|wget|nc|bash|sh|exec)\s)/i,
    riskLevel: 'HIGH',
    description: 'Shell command injection',
  },
];

// ─── Scanner ─────────────────────────────────

/**
 * Scan text for prompt injection patterns.
 *
 * @param text     - The text to scan (user prompt, agent input, etc.)
 * @param strict   - If true, lower threshold for flagging (default: false)
 * @returns ScanResult with findings and risk level
 */
export function scanText(text: string, strict = false): ScanResult {
  if (!text || text.trim().length === 0) {
    return {
      safe: true,
      riskLevel: 'LOW',
      findings: [],
      confidence: 100,
      scannedAt: new Date(),
    };
  }

  const findings: string[] = [];
  let maxRisk: RiskLevel = 'LOW';
  const riskOrder: RiskLevel[] = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'];

  for (const pattern of PATTERNS) {
    if (pattern.pattern.test(text)) {
      findings.push(`[${pattern.riskLevel}] ${pattern.name}: ${pattern.description}`);

      if (riskOrder.indexOf(pattern.riskLevel) > riskOrder.indexOf(maxRisk)) {
        maxRisk = pattern.riskLevel;
      }
    }
  }

  // Heuristic: long prompts with many special characters
  const specialCharRatio = (text.match(/[{}<>|;`\\]/g)?.length ?? 0) / text.length;
  if (specialCharRatio > 0.15) {
    findings.push('[MEDIUM] HIGH_SPECIAL_CHAR_RATIO: Unusual density of special characters');
    if (riskOrder.indexOf('MEDIUM') > riskOrder.indexOf(maxRisk)) {
      maxRisk = 'MEDIUM';
    }
  }

  // In strict mode, MEDIUM becomes HIGH
  if (strict && maxRisk === 'MEDIUM') {
    maxRisk = 'HIGH';
  }

  const safe = findings.length === 0 || (maxRisk === 'LOW');

  // Confidence: higher if more patterns match (more certain it's injection)
  const confidence = findings.length === 0
    ? 100
    : Math.min(99, 50 + findings.length * 15);

  if (!safe) {
    logger.warn(
      { riskLevel: maxRisk, findingCount: findings.length },
      'Prompt injection detected',
    );
  }

  return {
    safe,
    riskLevel: maxRisk,
    findings,
    confidence,
    scannedAt: new Date(),
  };
}

/**
 * Batch scan multiple texts. Returns the highest risk result.
 */
export function scanBatch(texts: string[], strict = false): ScanResult {
  const results = texts.map((t) => scanText(t, strict));
  const riskOrder: RiskLevel[] = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'];

  return results.reduce((worst, current) => {
    if (riskOrder.indexOf(current.riskLevel) > riskOrder.indexOf(worst.riskLevel)) {
      return current;
    }
    return worst;
  });
}

export type { InjectionPattern };
