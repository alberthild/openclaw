#!/usr/bin/env node
/**
 * Implicit Feedback Analyzer
 *
 * Analyzes conversation events to detect implicit feedback signals:
 * - Corrections ("Nein, ich meinte X")
 * - Style requests ("Kürzer", "Auf Deutsch", "Mehr Details")
 * - Positive signals ("Super", "Genau", "Perfekt")
 * - Negative signals ("Nein", "Falsch", "Nicht so")
 * - Ignored suggestions (advice not followed)
 *
 * Outputs behavioral adjustments to learning/{agent}/behavior.json
 *
 * Usage: node feedback-analyzer.mjs [hours=24]
 */

import { writeFileSync, readFileSync, existsSync, mkdirSync } from "fs";
import { connect, StringCodec } from "nats";
import { homedir } from "os";
import { join } from "path";

const HOURS = parseInt(process.argv[2]) || 24;
const NATS_URL = process.env.NATS_URL || "nats://claudia:iGm4DKGbq63YOsbopEjzA@localhost:4222";
const STREAM = "openclaw-events";

const CLAWD_DIR = join(homedir(), "clawd");
const LEARNING_DIR = join(CLAWD_DIR, "learning");

const sc = StringCodec();

// Feedback signal patterns
const SIGNALS = {
  // Positive feedback
  positive: [
    /^(super|genau|perfekt|danke|gut|nice|great|thanks|exactly|perfect)[\s!.]*$/i,
    /^(ja|yes|yep|jep|jo|yup)[\s!.]*$/i,
    /das (ist|war) (gut|super|perfekt|genau)/i,
    /👍|👏|🙌|❤️|🔥|✅/,
  ],

  // Negative feedback
  negative: [
    /^(nein|no|nope|ne)[\s!.]*$/i,
    /^(falsch|wrong|incorrect)/i,
    /nicht (so|das|richtig)/i,
    /das (stimmt|ist) nicht/i,
    /👎|❌|😕|🙄/,
  ],

  // Correction signals
  correction: [
    /ich mein(t?e?)/i,
    /nicht .*, sondern/i,
    /korrigier|correction|richtig ist/i,
    /das war falsch/i,
  ],

  // Style requests
  style: {
    shorter: [/kürzer|shorter|brief|kurz fassen|zu lang|too long/i],
    longer: [/mehr details|ausführlicher|longer|elaborate|mehr infos/i],
    simpler: [/einfacher|simpler|weniger technisch|verständlicher/i],
    technical: [/technischer|more technical|details|specifics/i],
    german: [/auf deutsch|in german|deutsch bitte/i],
    english: [/auf englisch|in english|english please/i],
    formal: [/formeller|formal|professional/i],
    casual: [/lockerer|casual|informal|entspannter/i],
  },

  // Rephrasing requests (indicates I wasn't clear)
  rephrase: [
    /was meinst du/i,
    /verstehe ich nicht/i,
    /kannst du .* erklären/i,
    /what do you mean/i,
    /unclear|unklar/i,
  ],
};

// Parse NATS URL
function parseNatsUrl(urlString) {
  try {
    const httpUrl = urlString.replace(/^nats:\/\//, "http://");
    const url = new URL(httpUrl);
    const servers = `${url.hostname}:${url.port || 4222}`;
    if (url.username && url.password) {
      return {
        servers,
        user: decodeURIComponent(url.username),
        pass: decodeURIComponent(url.password),
      };
    }
    return { servers };
  } catch {
    return { servers: urlString.replace(/^nats:\/\//, "") };
  }
}

// Load JSON with defaults
function loadJson(path, defaultVal = {}) {
  try {
    if (existsSync(path)) {
      return JSON.parse(readFileSync(path, "utf-8"));
    }
  } catch (err) {
    console.error(`Error loading ${path}:`, err.message);
  }
  return defaultVal;
}

// Check if text matches any pattern in array
function matchesAny(text, patterns) {
  return patterns.some((p) => p.test(text));
}

// Analyze a message for feedback signals
function analyzeMessage(text) {
  if (!text || text.length < 1) {
    return null;
  }

  // Skip system messages, heartbeats, cron notifications
  if (
    text.startsWith("System:") ||
    text.includes("HEARTBEAT_OK") ||
    text.includes("Cron:") ||
    text.includes("Exec completed") ||
    text.includes("Exec failed")
  ) {
    return null;
  }

  // Extract just the user message part (after timestamp prefix)
  const match = text.match(/\[.*?\]\s*(.+)$/s);
  const userText = match ? match[1].trim() : text.trim();

  const signals = {
    positive: matchesAny(userText, SIGNALS.positive),
    negative: matchesAny(userText, SIGNALS.negative),
    correction: matchesAny(userText, SIGNALS.correction),
    rephrase: matchesAny(userText, SIGNALS.rephrase),
    styleRequests: [],
  };

  // Check style requests
  for (const [style, patterns] of Object.entries(SIGNALS.style)) {
    if (matchesAny(userText, patterns)) {
      signals.styleRequests.push(style);
    }
  }

  // Return null if no signals detected
  if (
    !signals.positive &&
    !signals.negative &&
    !signals.correction &&
    !signals.rephrase &&
    signals.styleRequests.length === 0
  ) {
    return null;
  }

  return signals;
}

// Fetch events from NATS
async function fetchEvents(hours) {
  const connOpts = parseNatsUrl(NATS_URL);
  const nc = await connect(connOpts);
  const jsm = await nc.jetstreamManager();

  const info = await jsm.streams.info(STREAM);
  const totalMessages = info.state.messages;
  const lastSeq = info.state.last_seq;

  // Calculate time cutoff
  const cutoffTime = new Date(Date.now() - hours * 60 * 60 * 1000);

  console.log(`📊 Analyzing last ${hours}h of events`);
  console.log(`   Stream has ${totalMessages} total events`);
  console.log(`   Cutoff: ${cutoffTime.toISOString()}`);

  const events = [];
  const batchSize = 100;
  let foundOld = false;

  // Fetch backwards from last event
  for (let seq = lastSeq; seq >= 1 && !foundOld; seq -= batchSize) {
    const startSeq = Math.max(1, seq - batchSize + 1);

    for (let s = seq; s >= startSeq; s--) {
      try {
        const msg = await jsm.streams.getMessage(STREAM, { seq: s });
        const event = JSON.parse(sc.decode(msg.data));

        // Check timestamp
        const eventTime = new Date(event.timestamp || event.ts);
        if (eventTime < cutoffTime) {
          foundOld = true;
          break;
        }

        // Only user messages
        if (event.type === "conversation.message.in") {
          // Extract content from various formats
          let content = event.payload?.content;
          if (!content && event.payload?.text_preview) {
            // New format: text_preview is array of {type, text}
            const preview = event.payload.text_preview;
            if (Array.isArray(preview) && preview[0]?.text) {
              content = preview[0].text;
            }
          }
          if (!content && event.payload?.text) {
            content = event.payload.text;
          }

          if (content) {
            events.push({
              seq: s,
              timestamp: eventTime,
              agent: event.agent || "main",
              content: content,
            });
          }
        }
      } catch {
        // Skip missing sequences
      }
    }

    if (events.length % 200 === 0 && events.length > 0) {
      process.stdout.write(`   Processed ${events.length} user messages...\r`);
    }
  }

  await nc.close();
  console.log(`   Found ${events.length} user messages in time range`);

  return events;
}

// Main analysis
async function analyze() {
  const events = await fetchEvents(HOURS);

  // Aggregate signals by agent
  const agentSignals = {};

  for (const event of events) {
    const agent = event.agent;
    if (!agentSignals[agent]) {
      agentSignals[agent] = {
        positive: 0,
        negative: 0,
        corrections: 0,
        rephraseRequests: 0,
        styleRequests: {},
        examples: {
          positive: [],
          negative: [],
          corrections: [],
        },
        totalMessages: 0,
      };
    }

    agentSignals[agent].totalMessages++;

    const signals = analyzeMessage(event.content);
    if (!signals) {
      continue;
    }

    if (signals.positive) {
      agentSignals[agent].positive++;
      if (agentSignals[agent].examples.positive.length < 5) {
        agentSignals[agent].examples.positive.push(event.content.slice(0, 100));
      }
    }

    if (signals.negative) {
      agentSignals[agent].negative++;
      if (agentSignals[agent].examples.negative.length < 5) {
        agentSignals[agent].examples.negative.push(event.content.slice(0, 100));
      }
    }

    if (signals.correction) {
      agentSignals[agent].corrections++;
      if (agentSignals[agent].examples.corrections.length < 5) {
        agentSignals[agent].examples.corrections.push(event.content.slice(0, 100));
      }
    }

    if (signals.rephrase) {
      agentSignals[agent].rephraseRequests++;
    }

    for (const style of signals.styleRequests) {
      agentSignals[agent].styleRequests[style] =
        (agentSignals[agent].styleRequests[style] || 0) + 1;
    }
  }

  // Generate behavioral adjustments
  console.log("\n📈 Generating behavioral adjustments...\n");

  for (const [agent, signals] of Object.entries(agentSignals)) {
    const agentDir = join(LEARNING_DIR, agent);
    if (!existsSync(agentDir)) {
      mkdirSync(agentDir, { recursive: true });
    }

    // Load existing behavior config
    const behaviorPath = join(agentDir, "behavior.json");
    const behavior = loadJson(behaviorPath, {
      adjustments: {},
      history: [],
      lastUpdate: null,
    });

    // Calculate ratios
    const total = signals.totalMessages || 1;
    const positiveRatio = signals.positive / total;
    const negativeRatio = signals.negative / total;
    const correctionRatio = signals.corrections / total;
    const rephraseRatio = signals.rephraseRequests / total;

    // Derive adjustments
    const adjustments = {
      // Satisfaction score (positive - negative)
      satisfactionScore: Math.round((positiveRatio - negativeRatio) * 100),

      // Clarity score (inverse of rephrase requests)
      clarityScore: Math.round((1 - rephraseRatio) * 100),

      // Style adjustments based on explicit requests
      preferShorter: (signals.styleRequests.shorter || 0) > (signals.styleRequests.longer || 0),
      preferTechnical:
        (signals.styleRequests.technical || 0) > (signals.styleRequests.simpler || 0),
      preferGerman: (signals.styleRequests.german || 0) > (signals.styleRequests.english || 0),
      preferCasual: (signals.styleRequests.casual || 0) > (signals.styleRequests.formal || 0),

      // Warnings
      highCorrectionRate: correctionRatio > 0.05,
      lowClarity: rephraseRatio > 0.1,
    };

    // Add to history
    behavior.history.push({
      timestamp: new Date().toISOString(),
      period: `${HOURS}h`,
      signals: {
        positive: signals.positive,
        negative: signals.negative,
        corrections: signals.corrections,
        rephraseRequests: signals.rephraseRequests,
        styleRequests: signals.styleRequests,
        totalMessages: signals.totalMessages,
      },
      adjustments,
    });

    // Keep last 30 entries
    if (behavior.history.length > 30) {
      behavior.history = behavior.history.slice(-30);
    }

    // Update current adjustments
    behavior.adjustments = adjustments;
    behavior.lastUpdate = new Date().toISOString();
    behavior.examples = signals.examples;

    // Save
    writeFileSync(behaviorPath, JSON.stringify(behavior, null, 2));

    // Print summary
    console.log(`Agent: ${agent}`);
    console.log(`  Messages analyzed: ${signals.totalMessages}`);
    console.log(`  Positive signals: ${signals.positive} (${(positiveRatio * 100).toFixed(1)}%)`);
    console.log(`  Negative signals: ${signals.negative} (${(negativeRatio * 100).toFixed(1)}%)`);
    console.log(`  Corrections: ${signals.corrections} (${(correctionRatio * 100).toFixed(1)}%)`);
    console.log(
      `  Rephrase requests: ${signals.rephraseRequests} (${(rephraseRatio * 100).toFixed(1)}%)`,
    );
    console.log(`  Satisfaction score: ${adjustments.satisfactionScore}`);
    console.log(`  Clarity score: ${adjustments.clarityScore}`);
    if (Object.keys(signals.styleRequests).length > 0) {
      console.log(`  Style preferences: ${JSON.stringify(signals.styleRequests)}`);
    }
    console.log(`  Saved to: ${behaviorPath}`);
    console.log("");
  }

  // Generate behavioral context for system prompt
  console.log("📝 Generating behavioral context...\n");

  const mainBehavior = loadJson(join(LEARNING_DIR, "main", "behavior.json"), {});
  if (mainBehavior.adjustments) {
    const adj = mainBehavior.adjustments;

    let context = `## Behavioral Adjustments

*Auto-generated from implicit feedback signals*
*Last ${HOURS}h of conversation analysis*
*Updated: ${new Date().toISOString()}*

### Current Adjustments

`;

    if (adj.satisfactionScore !== undefined) {
      const satisfaction =
        adj.satisfactionScore > 20
          ? "😊 High"
          : adj.satisfactionScore < -10
            ? "😕 Low"
            : "😐 Neutral";
      context += `- **Satisfaction**: ${satisfaction} (score: ${adj.satisfactionScore})\n`;
    }

    if (adj.clarityScore !== undefined) {
      const clarity =
        adj.clarityScore > 90
          ? "✅ Clear"
          : adj.clarityScore < 80
            ? "⚠️ Needs improvement"
            : "👍 Good";
      context += `- **Clarity**: ${clarity} (score: ${adj.clarityScore})\n`;
    }

    if (adj.highCorrectionRate) {
      context += `- **⚠️ High correction rate** — Be more careful, verify before stating\n`;
    }

    if (adj.lowClarity) {
      context += `- **⚠️ Low clarity** — Explain more clearly, avoid ambiguity\n`;
    }

    context += "\n### Style Preferences\n\n";
    context += adj.preferShorter
      ? "- Keep responses **concise**\n"
      : "- Detailed responses are welcome\n";
    context += adj.preferTechnical ? "- Use **technical depth**\n" : "- Keep it **accessible**\n";
    context += adj.preferGerman ? "- Prefer **Deutsch**\n" : "- Language is flexible\n";
    context += adj.preferCasual
      ? "- **Casual** tone preferred\n"
      : "- Maintain professional tone\n";

    if (mainBehavior.examples?.corrections?.length > 0) {
      context += "\n### Recent Corrections (learn from these)\n\n";
      for (const ex of mainBehavior.examples.corrections.slice(0, 3)) {
        context += `- "${ex}"\n`;
      }
    }

    context +=
      "\n---\n\n*These adjustments are derived from implicit signals. Explicit requests always override.*\n";

    const behaviorContextPath = join(LEARNING_DIR, "main", "behavior-context.md");
    writeFileSync(behaviorContextPath, context);
    console.log(`Written to: ${behaviorContextPath}`);
  }

  console.log("\n✅ Feedback analysis complete!");
}

analyze().catch((e) => {
  console.error("Analysis failed:", e);
  process.exit(1);
});
