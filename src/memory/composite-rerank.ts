/**
 * Composite Re-ranking for memory search results.
 *
 * Ports intent classification + composite scoring from Python prototypes
 * in ~/clawd/staging/memory-enhancements/ into TypeScript.
 *
 * Single entry point: reRankResults()
 */

import type { MemorySearchResult } from "./types.js";

// ─── Config Types ───────────────────────────────────────────────────────────

export interface CompositeRerankConfig {
  enabled?: boolean;
  weights?: {
    search?: number;
    recency?: number;
    source?: number;
    confidence?: number;
  };
  recencyHalfLifeDays?: number;
  sourceWeights?: Record<string, number>;
}

// ─── Intent Classification ──────────────────────────────────────────────────

export type IntentType = "WHO" | "WHEN" | "WHY" | "WHAT";

export interface IntentResult {
  intent: IntentType;
  confidence: number;
  signals: string[];
}

/** Words that look like person names (capitalized) but aren't. */
const NON_PERSON_CAPS = new Set([
  "sparkasse",
  "taskboard",
  "uptime",
  "kuma",
  "forgejo",
  "traefik",
  "nginx",
  "docker",
  "chromadb",
  "typedb",
  "nats",
  "kafka",
  "pinecone",
  "odoo",
  "mondo",
  "gate",
  "vainplex",
  "openclaw",
  "telegram",
  "discord",
  "matrix",
  "opus",
  "sonnet",
  "haiku",
  "claude",
  "gemini",
  "ollama",
  "mona",
  "vera",
  "stella",
  "viola",
  "hetzner",
  "proxmox",
  "debian",
  "linux",
  "python",
  "api",
  "cli",
  "dns",
  "ssl",
  "tls",
  "ssh",
  "http",
  "https",
  "sepa",
  "bafin",
  "iso",
  "iban",
  "postgres",
  "sqlite",
  "redis",
  "github",
  // Common German capitalized nouns
  "aufgabe",
  "zugang",
  "status",
  "server",
  "konto",
  "liste",
  "daten",
  "problem",
  "fehler",
  "lösung",
  "version",
  "projekt",
  "system",
  "email",
  "rechnung",
  "zahlung",
  "vertrag",
  "termin",
  "meeting",
  "deploy",
  "update",
  "config",
  "setup",
  "deployment",
  "monitoring",
  "backup",
  "migration",
  "integration",
  "infrastruktur",
  "netzwerk",
  "sicherheit",
]);

const DATE_TOKEN_RE = /\b\d{4}[-/]\d{2}/;
const MONTH_RE = /\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec|januar|februar|märz)\b/i;

export function classifyIntent(query: string): IntentResult {
  if (!query || !query.trim()) {
    return { intent: "WHAT", confidence: 0.1, signals: ["empty_query"] };
  }

  const lower = query.toLowerCase().trim();
  const scores: Record<IntentType, number> = { WHO: 0, WHEN: 0, WHY: 0, WHAT: 0 };
  const signals: Record<IntentType, string[]> = { WHO: [], WHEN: [], WHY: [], WHAT: [] };

  // Question words at start (strongest signal)
  if (/^(?:warum|why|wieso|weshalb)\s/.test(lower)) {
    scores.WHY += 3.0;
    signals.WHY.push("start_why");
  } else if (/^(?:wer|who)\s/.test(lower)) {
    scores.WHO += 3.0;
    signals.WHO.push("start_who");
  } else if (/^(?:wann|when)\s/.test(lower)) {
    scores.WHEN += 3.0;
    signals.WHEN.push("start_when");
  }

  // WHO keywords
  for (const kw of ["contact", "kontakt", "person", "name", "zuständig", "responsible", "team"]) {
    if (lower.includes(kw)) {
      scores.WHO += 1.0;
      signals.WHO.push(`kw:${kw}`);
    }
  }

  // WHEN keywords
  for (const kw of [
    "when",
    "wann",
    "date",
    "datum",
    "timeline",
    "schedule",
    "zeitplan",
    "deadline",
  ]) {
    if (lower.includes(kw)) {
      scores.WHEN += 1.0;
      signals.WHEN.push(`kw:${kw}`);
    }
  }

  // WHY keywords
  for (const kw of [
    "why",
    "warum",
    "reason",
    "grund",
    "wieso",
    "weshalb",
    "rationale",
    "motivation",
  ]) {
    if (lower.includes(kw)) {
      scores.WHY += 1.0;
      signals.WHY.push(`kw:${kw}`);
    }
  }

  // Capitalized words → WHO heuristic (with German noun blocklist)
  const words = query.split(/\s+/);
  if (words.length >= 2) {
    const caps = words.filter(
      (w) => w.length > 2 && /^[A-ZÄÖÜ][a-zäöüß]/.test(w) && !NON_PERSON_CAPS.has(w.toLowerCase()),
    );
    if (caps.length >= 2) {
      scores.WHO += 0.8 * caps.length;
      signals.WHO.push(`multi_caps:${caps.slice(0, 3).join(",")}`);
    } else if (caps.length === 1) {
      scores.WHO += 0.3;
      signals.WHO.push(`caps:${caps[0]}`);
    }
  }

  // Date tokens → WHEN
  if (DATE_TOKEN_RE.test(query) || MONTH_RE.test(lower)) {
    scores.WHEN += 1.5;
    signals.WHEN.push("date_token");
  }

  // Pick winner
  let bestIntent: IntentType = "WHAT";
  let bestScore = 0;
  for (const intent of ["WHO", "WHEN", "WHY", "WHAT"] as IntentType[]) {
    if (scores[intent] > bestScore) {
      bestScore = scores[intent];
      bestIntent = intent;
    }
  }

  const total = scores.WHO + scores.WHEN + scores.WHY + scores.WHAT;
  let confidence = total > 0 ? bestScore / total : 0.25;

  if (bestScore < 0.5) {
    bestIntent = "WHAT";
    confidence = 0.3;
  }

  return {
    intent: bestIntent,
    confidence: Math.round(confidence * 1000) / 1000,
    signals: signals[bestIntent],
  };
}

// ─── Composite Scoring ──────────────────────────────────────────────────────

const DATE_PATH_RE = /(\d{4})-(\d{2})-(\d{2})/;

function extractDateFromPath(path: string): Date | null {
  const m = DATE_PATH_RE.exec(path);
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return isNaN(d.getTime()) ? null : d;
}

export function recencyScore(
  resultDate: Date | null,
  referenceDate: Date,
  halfLifeDays: number,
): number {
  if (!resultDate) return 0.3;
  const msPerDay = 86_400_000;
  let daysOld = (referenceDate.getTime() - resultDate.getTime()) / msPerDay;
  if (daysOld < 0) daysOld = 0;
  return Math.pow(2, -daysOld / halfLifeDays);
}

const DEFAULT_SOURCE_WEIGHTS: Record<string, number> = {
  "MEMORY.md": 1.1,
  "WORKING.md": 1.0,
  "memory/": 0.8,
  sessions: 0.5,
  default: 0.7,
};

function sourceWeight(path: string, weights: Record<string, number>): number {
  const w = weights;
  const norm = path.replace(/\\/g, "/");

  // Most specific first
  let best = w.default ?? DEFAULT_SOURCE_WEIGHTS.default!;
  let bestLen = 0;

  for (const [pattern, weight] of Object.entries(w)) {
    if (pattern === "default") continue;
    if (norm.includes(pattern) && pattern.length > bestLen) {
      best = weight;
      bestLen = pattern.length;
    }
  }
  return best;
}

function multiTermConfidence(query: string, text: string): number {
  const terms = query
    .toLowerCase()
    .split(/\s+/)
    .filter((t) => t.length > 2);
  if (terms.length === 0) return 0.5;
  const lowerText = text.toLowerCase();
  const matched = terms.filter((t) => lowerText.includes(t)).length;
  return matched / terms.length;
}

/** Intent-based weight adjustments. */
function adjustWeightsForIntent(
  intent: IntentType,
  weights: Required<NonNullable<CompositeRerankConfig["weights"]>>,
): Required<NonNullable<CompositeRerankConfig["weights"]>> {
  const w = { ...weights };
  switch (intent) {
    case "WHEN":
      w.recency = Math.min(1, w.recency + 0.15);
      w.search = Math.max(0, w.search - 0.1);
      break;
    case "WHO":
      w.confidence = Math.min(1, w.confidence + 0.1);
      w.search = Math.max(0, w.search - 0.05);
      break;
    case "WHY":
      w.source = Math.min(1, w.source + 0.1);
      w.recency = Math.max(0, w.recency - 0.05);
      break;
  }
  return w;
}

// ─── Main Entry Point ───────────────────────────────────────────────────────

const DEFAULT_WEIGHTS = { search: 0.5, recency: 0.25, source: 0.15, confidence: 0.1 };

export function reRankResults(
  results: MemorySearchResult[],
  query: string,
  config?: CompositeRerankConfig,
  /** Exposed for testing — defaults to now. */
  referenceDate?: Date,
): MemorySearchResult[] {
  if (config?.enabled === false) return results;
  if (results.length === 0) return results;

  const intent = classifyIntent(query);
  const halfLife = config?.recencyHalfLifeDays ?? 14;
  const srcWeights = { ...DEFAULT_SOURCE_WEIGHTS, ...config?.sourceWeights };
  const baseWeights = { ...DEFAULT_WEIGHTS, ...config?.weights };
  const w = adjustWeightsForIntent(intent.intent, baseWeights);
  const refDate = referenceDate ?? new Date();

  const scored = results.map((r) => {
    const rDate = extractDateFromPath(r.path);
    const rRecency = recencyScore(rDate, refDate, halfLife);
    const rSource = sourceWeight(r.path, srcWeights);
    const rConfidence = multiTermConfidence(query, r.snippet);

    const finalScore =
      w.search * r.score + w.recency * rRecency + w.source * rSource + w.confidence * rConfidence;

    return { ...r, score: Math.min(1, finalScore) };
  });

  scored.sort((a, b) => b.score - a.score);
  return scored;
}
