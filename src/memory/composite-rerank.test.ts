import { describe, expect, it } from "vitest";
import type { MemorySearchResult } from "./types.js";
import {
  classifyIntent,
  reRankResults,
  recencyScore,
  type CompositeRerankConfig,
  type IntentType,
} from "./composite-rerank.js";

// ─── Helpers ────────────────────────────────────────────────────────────────

function makeResult(overrides: Partial<MemorySearchResult> = {}): MemorySearchResult {
  return {
    path: "memory/2026-02-01.md",
    startLine: 1,
    endLine: 5,
    score: 0.8,
    snippet: "some content about gateway fix",
    source: "memory",
    ...overrides,
  };
}

const REF_DATE = new Date(2026, 1, 8); // 2026-02-08

// ─── Intent Classification ──────────────────────────────────────────────────

describe("classifyIntent", () => {
  // English
  it("classifies WHO from 'who' start", () => {
    expect(classifyIntent("who is Albert").intent).toBe("WHO");
  });

  it("classifies WHEN from 'when' start", () => {
    expect(classifyIntent("when did we fix the gateway").intent).toBe("WHEN");
  });

  it("classifies WHY from 'why' start", () => {
    expect(classifyIntent("why did we choose NATS").intent).toBe("WHY");
  });

  it("classifies WHAT as default", () => {
    expect(classifyIntent("gateway status").intent).toBe("WHAT");
  });

  // German
  it("classifies WHO from 'wer'", () => {
    expect(classifyIntent("wer ist Sebastian Baier").intent).toBe("WHO");
  });

  it("classifies WHEN from 'wann'", () => {
    expect(classifyIntent("wann wurde TypeDB eingerichtet").intent).toBe("WHEN");
  });

  it("classifies WHY from 'warum'", () => {
    expect(classifyIntent("warum ChromaDB statt Pinecone").intent).toBe("WHY");
  });

  it("classifies WHY from 'wieso'", () => {
    expect(classifyIntent("wieso haben wir das gemacht").intent).toBe("WHY");
  });

  it("classifies WHY from 'weshalb'", () => {
    expect(classifyIntent("weshalb NATS statt Kafka").intent).toBe("WHY");
  });

  // German noun handling — should NOT trigger WHO
  it("does not classify Sparkasse as WHO", () => {
    expect(classifyIntent("Sparkasse Konto Status").intent).not.toBe("WHO");
  });

  it("does not classify TaskBoard as WHO", () => {
    expect(classifyIntent("TaskBoard Setup").intent).not.toBe("WHO");
  });

  it("does not classify Docker Deployment as WHO", () => {
    expect(classifyIntent("Docker Deployment Status").intent).not.toBe("WHO");
  });

  // Person names SHOULD trigger WHO
  it("classifies 'Albert Hild' as WHO via multi-caps", () => {
    expect(classifyIntent("Albert Hild contact").intent).toBe("WHO");
  });

  it("classifies 'Sebastian Baier' as WHO via multi-caps", () => {
    expect(classifyIntent("Sebastian Baier").intent).toBe("WHO");
  });

  // Date tokens → WHEN
  it("detects date tokens as WHEN signal", () => {
    expect(classifyIntent("events 2026-01-15").intent).toBe("WHEN");
  });

  it("detects month names as WHEN signal", () => {
    expect(classifyIntent("meeting in Januar").intent).toBe("WHEN");
  });

  // Edge cases
  it("handles empty query", () => {
    const r = classifyIntent("");
    expect(r.intent).toBe("WHAT");
    expect(r.confidence).toBeLessThan(0.2);
  });

  it("handles whitespace-only query", () => {
    expect(classifyIntent("   ").intent).toBe("WHAT");
  });

  it("returns confidence between 0 and 1", () => {
    const r = classifyIntent("who is the contact person");
    expect(r.confidence).toBeGreaterThan(0);
    expect(r.confidence).toBeLessThanOrEqual(1);
  });

  it("includes signals array", () => {
    const r = classifyIntent("who is Albert");
    expect(r.signals.length).toBeGreaterThan(0);
  });
});

// ─── Recency Score ──────────────────────────────────────────────────────────

describe("recencyScore", () => {
  it("returns 1.0 for today", () => {
    expect(recencyScore(REF_DATE, REF_DATE, 14)).toBeCloseTo(1.0);
  });

  it("returns ~0.5 at half-life", () => {
    const d = new Date(2026, 0, 25); // 14 days before Feb 8
    expect(recencyScore(d, REF_DATE, 14)).toBeCloseTo(0.5, 1);
  });

  it("returns ~0.25 at 2x half-life", () => {
    const d = new Date(2026, 0, 11); // 28 days before Feb 8
    expect(recencyScore(d, REF_DATE, 14)).toBeCloseTo(0.25, 1);
  });

  it("returns 0.3 for null date", () => {
    expect(recencyScore(null, REF_DATE, 14)).toBe(0.3);
  });

  it("treats future dates as today", () => {
    const future = new Date(2026, 2, 1);
    expect(recencyScore(future, REF_DATE, 14)).toBeCloseTo(1.0);
  });

  it("very old dates approach 0", () => {
    const old = new Date(2024, 0, 1);
    expect(recencyScore(old, REF_DATE, 14)).toBeLessThan(0.01);
  });
});

// ─── Re-ranking Pipeline ────────────────────────────────────────────────────

describe("reRankResults", () => {
  it("returns empty array for empty input", () => {
    expect(reRankResults([], "test")).toEqual([]);
  });

  it("re-sorts by composite score", () => {
    const results: MemorySearchResult[] = [
      makeResult({ path: "memory/2025-01-01.md", score: 0.9, snippet: "old content" }),
      makeResult({ path: "memory/2026-02-07.md", score: 0.7, snippet: "recent gateway fix" }),
      makeResult({ path: "MEMORY.md", score: 0.75, snippet: "gateway architecture" }),
    ];
    const ranked = reRankResults(results, "gateway fix", undefined, REF_DATE);
    // Recent + high source weight items should rank higher
    expect(ranked.length).toBe(3);
    // The old result should not be first despite highest original score
    expect(ranked[0].path).not.toBe("memory/2025-01-01.md");
  });

  it("MEMORY.md gets source boost over daily notes", () => {
    const results: MemorySearchResult[] = [
      makeResult({ path: "memory/2026-02-07.md", score: 0.8, snippet: "daily note" }),
      makeResult({ path: "MEMORY.md", score: 0.8, snippet: "curated content" }),
    ];
    const ranked = reRankResults(results, "test query", undefined, REF_DATE);
    const memoryMd = ranked.find((r) => r.path === "MEMORY.md")!;
    const daily = ranked.find((r) => r.path === "memory/2026-02-07.md")!;
    // MEMORY.md source weight (1.1) > daily (0.8)
    expect(memoryMd.score).toBeGreaterThan(daily.score);
  });

  it("sessions get lower source weight", () => {
    const results: MemorySearchResult[] = [
      makeResult({
        path: "sessions/2026-02-07.md",
        score: 0.8,
        snippet: "session content",
        source: "sessions",
      }),
      makeResult({ path: "memory/2026-02-07.md", score: 0.8, snippet: "memory content" }),
    ];
    const ranked = reRankResults(results, "test", undefined, REF_DATE);
    const session = ranked.find((r) => r.path.startsWith("sessions"))!;
    const mem = ranked.find((r) => r.path.startsWith("memory"))!;
    expect(mem.score).toBeGreaterThan(session.score);
  });

  it("respects enabled=false config", () => {
    const results = [makeResult({ score: 0.5 }), makeResult({ score: 0.9 })];
    const ranked = reRankResults(results, "test", { enabled: false });
    // Should return unchanged
    expect(ranked[0].score).toBe(0.5);
    expect(ranked[1].score).toBe(0.9);
  });

  it("handles results without date in path", () => {
    const results = [makeResult({ path: "MEMORY.md", score: 0.8 })];
    const ranked = reRankResults(results, "test", undefined, REF_DATE);
    expect(ranked.length).toBe(1);
    expect(ranked[0].score).toBeGreaterThan(0);
  });

  it("handles empty query", () => {
    const results = [makeResult()];
    const ranked = reRankResults(results, "", undefined, REF_DATE);
    expect(ranked.length).toBe(1);
  });

  it("caps scores at 1.0", () => {
    const results = [
      makeResult({ score: 1.0, path: "MEMORY.md", snippet: "gateway gateway gateway" }),
    ];
    const ranked = reRankResults(results, "gateway", undefined, REF_DATE);
    expect(ranked[0].score).toBeLessThanOrEqual(1.0);
  });

  it("custom config weights are applied", () => {
    const results = [
      makeResult({ path: "memory/2026-02-07.md", score: 0.5, snippet: "recent" }),
      makeResult({ path: "memory/2025-01-01.md", score: 0.9, snippet: "old high score" }),
    ];
    // Heavy recency weight
    const config: CompositeRerankConfig = {
      weights: { search: 0.1, recency: 0.8, source: 0.05, confidence: 0.05 },
    };
    const ranked = reRankResults(results, "test", config, REF_DATE);
    expect(ranked[0].path).toBe("memory/2026-02-07.md");
  });

  it("custom source weights work", () => {
    const results = [
      makeResult({ path: "custom/special.md", score: 0.8, snippet: "special" }),
      makeResult({ path: "memory/2026-02-07.md", score: 0.8, snippet: "normal" }),
    ];
    const config: CompositeRerankConfig = { sourceWeights: { "custom/": 1.5 } };
    const ranked = reRankResults(results, "test", config, REF_DATE);
    const special = ranked.find((r) => r.path.startsWith("custom"))!;
    const normal = ranked.find((r) => r.path.startsWith("memory"))!;
    expect(special.score).toBeGreaterThan(normal.score);
  });

  it("WHEN query boosts recency weight", () => {
    const results = [
      makeResult({ path: "memory/2026-02-07.md", score: 0.6, snippet: "recent fix" }),
      makeResult({ path: "memory/2025-06-01.md", score: 0.9, snippet: "old high score fix" }),
    ];
    const ranked = reRankResults(results, "when did we fix the gateway", undefined, REF_DATE);
    // Recency boost should help the recent result
    expect(ranked[0].path).toBe("memory/2026-02-07.md");
  });

  it("preserves all result fields", () => {
    const original = makeResult({ startLine: 10, endLine: 20, citation: "test" });
    const ranked = reRankResults([original], "test", undefined, REF_DATE);
    expect(ranked[0].startLine).toBe(10);
    expect(ranked[0].endLine).toBe(20);
    expect(ranked[0].source).toBe("memory");
  });

  it("WORKING.md gets weight 1.0", () => {
    const results = [
      makeResult({ path: "memory/WORKING.md", score: 0.8, snippet: "working memory" }),
      makeResult({ path: "memory/2026-02-07.md", score: 0.8, snippet: "daily note" }),
    ];
    const ranked = reRankResults(results, "test", undefined, REF_DATE);
    const working = ranked.find((r) => r.path.includes("WORKING.md"))!;
    const daily = ranked.find((r) => !r.path.includes("WORKING.md"))!;
    expect(working.score).toBeGreaterThan(daily.score);
  });
});
