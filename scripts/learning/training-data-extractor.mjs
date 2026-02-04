#!/usr/bin/env node
/**
 * Training Data Extractor
 * 
 * Extracts high-quality conversation pairs from NATS events for fine-tuning.
 * Filters for:
 * - Complete exchanges (user message → assistant response)
 * - Positive feedback signals
 * - Non-trivial exchanges (not just "ok", "ja", etc.)
 * 
 * Outputs:
 * - JSONL format for OpenAI fine-tuning
 * - Alpaca format for local LoRA training
 * 
 * Usage: node training-data-extractor.mjs [hours=168] [--min-quality=0.5]
 */

import { connect, StringCodec } from 'nats';
import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

const HOURS = parseInt(process.argv[2]) || 168; // Default: 1 week
const MIN_QUALITY = parseFloat(process.argv.find(a => a.startsWith('--min-quality='))?.split('=')[1] || '0.3');

const NATS_URL = process.env.NATS_URL || 'nats://claudia:iGm4DKGbq63YOsbopEjzA@localhost:4222';
const STREAM = 'openclaw-events';

const CLAWD_DIR = join(homedir(), 'clawd');
const OUTPUT_DIR = join(CLAWD_DIR, 'training-data');

const sc = StringCodec();

// Quality signals
const POSITIVE_SIGNALS = [
  /^(super|genau|perfekt|danke|gut|nice|great|thanks|exactly|perfect|prima|toll|klasse)[\s!\.]*$/i,
  /^(ja|yes|yep|jep|jo|yup|ok|okay|alles klar|verstanden)[\s!\.]*$/i,
  /das (ist|war) (gut|super|perfekt|genau|hilfreich)/i,
  /👍|👏|🙌|❤️|🔥|✅/,
  /genau (das|so)/i,
  /macht sinn/i,
];

const NEGATIVE_SIGNALS = [
  /^(nein|no|nope|ne|falsch|wrong)[\s!\.]*$/i,
  /nicht (so|das|richtig|was ich|gemeint)/i,
  /das stimmt nicht/i,
  /versteh ich nicht/i,
  /👎|❌/,
];

// Skip these patterns (not useful for training)
const SKIP_PATTERNS = [
  /^system:/i,
  /heartbeat_ok/i,
  /^cron:/i,
  /exec completed/i,
  /exec failed/i,
  /^\d+$/, // Just numbers
  /^[\s\.\,\!\?]+$/, // Just punctuation
];

// Parse NATS URL
function parseNatsUrl(urlString) {
  try {
    const httpUrl = urlString.replace(/^nats:\/\//, 'http://');
    const url = new URL(httpUrl);
    const servers = `${url.hostname}:${url.port || 4222}`;
    if (url.username && url.password) {
      return { servers, user: decodeURIComponent(url.username), pass: decodeURIComponent(url.password) };
    }
    return { servers };
  } catch {
    return { servers: urlString.replace(/^nats:\/\//, '') };
  }
}

// Check if text matches any pattern
function matchesAny(text, patterns) {
  return patterns.some(p => p.test(text));
}

// Extract user text from event
function extractUserText(event) {
  if (event.type !== 'conversation.message.in') return null;
  
  let content = event.payload?.content;
  if (!content && event.payload?.text_preview) {
    const preview = event.payload.text_preview;
    if (Array.isArray(preview) && preview[0]?.text) {
      content = preview[0].text;
    }
  }
  if (!content && event.payload?.text) {
    content = event.payload.text;
  }
  
  if (!content) return null;
  
  // Skip system messages
  if (matchesAny(content, SKIP_PATTERNS)) return null;
  
  // Extract actual user message (after timestamp)
  const match = content.match(/\[.*?\d{4}\]\s*(.+)$/s);
  return match ? match[1].trim() : content.trim();
}

// Extract assistant text from event  
function extractAssistantText(event) {
  if (event.type !== 'conversation.message.out') return null;
  
  // New format: payload.data.text
  let content = event.payload?.data?.text;
  
  // Fallback formats
  if (!content) content = event.payload?.content;
  if (!content && event.payload?.text_preview) {
    const preview = event.payload.text_preview;
    if (Array.isArray(preview) && preview[0]?.text) {
      content = preview[0].text;
    }
  }
  if (!content) content = event.payload?.text;
  
  // Don't skip short chunks here - we'll select the longest one in the pair extraction
  
  return content?.trim() || null;
}

// Extract session ID from event
function extractSessionId(event) {
  // message.out uses payload.runId which matches message.in's sessionId
  if (event.type === 'conversation.message.out' && event.payload?.runId) {
    return event.payload.runId;
  }
  // message.in uses payload.sessionId
  if (event.payload?.sessionId) return event.payload.sessionId;
  // Fallback to sessionKey
  if (event.payload?.sessionKey) {
    const parts = event.payload.sessionKey.split(':');
    return parts.length >= 3 ? parts.slice(1).join(':') : event.payload.sessionKey;
  }
  return event.sessionId || 'unknown';
}

// Calculate quality score for a conversation pair
function calculateQuality(userMsg, assistantMsg, followUp) {
  let score = 0.5; // Base score
  
  // Length factors
  if (userMsg.length > 50) score += 0.1; // Non-trivial question
  if (assistantMsg.length > 200) score += 0.1; // Substantive answer
  if (assistantMsg.length > 1000) score += 0.1; // Detailed answer
  
  // Follow-up signals
  if (followUp) {
    if (matchesAny(followUp, POSITIVE_SIGNALS)) score += 0.3;
    if (matchesAny(followUp, NEGATIVE_SIGNALS)) score -= 0.4;
  }
  
  // Content quality signals
  if (assistantMsg.includes('```')) score += 0.1; // Contains code
  if (assistantMsg.includes('|')) score += 0.05; // Contains table
  if (/\d\.\s/.test(assistantMsg)) score += 0.05; // Numbered list
  
  // Penalize very short exchanges
  if (userMsg.length < 10) score -= 0.2;
  if (assistantMsg.length < 50) score -= 0.2;
  
  // Penalize if assistant said "I don't know" or similar
  if (/kann ich nicht|weiß ich nicht|i don't know|i cannot/i.test(assistantMsg)) {
    score -= 0.3;
  }
  
  return Math.max(0, Math.min(1, score));
}

// Fetch events from NATS
async function fetchEvents(hours) {
  const connOpts = parseNatsUrl(NATS_URL);
  const nc = await connect(connOpts);
  const jsm = await nc.jetstreamManager();
  
  const info = await jsm.streams.info(STREAM);
  const totalMessages = info.state.messages;
  const lastSeq = info.state.last_seq;
  
  const cutoffTime = new Date(Date.now() - hours * 60 * 60 * 1000);
  
  console.log(`📊 Extracting training data from last ${hours}h`);
  console.log(`   Stream has ${totalMessages} total events`);
  console.log(`   Cutoff: ${cutoffTime.toISOString()}`);
  
  const events = [];
  let foundOld = false;
  let skipped = 0;
  let checked = 0;
  
  // Fetch backwards - check up to 100000 sequences or until we hit cutoff
  const maxCheck = Math.min(lastSeq, 100000);
  
  for (let seq = lastSeq; seq >= Math.max(1, lastSeq - maxCheck) && !foundOld; seq--) {
    checked++;
    try {
      const msg = await jsm.streams.getMessage(STREAM, { seq });
      const event = JSON.parse(sc.decode(msg.data));
      
      // Skip test/benchmark events (no .type field)
      if (!event.type) {
        skipped++;
        continue;
      }
      
      // Handle timestamp - could be ISO string or unix milliseconds
      let eventTime;
      const ts = event.timestamp || event.ts;
      if (typeof ts === 'number') {
        eventTime = new Date(ts); // Unix milliseconds
      } else if (typeof ts === 'string') {
        eventTime = new Date(ts); // ISO string
      } else {
        skipped++;
        continue; // Skip if no timestamp - don't break, just skip
      }
      
      if (isNaN(eventTime.getTime())) {
        skipped++;
        continue; // Skip invalid timestamps
      }
      
      if (eventTime < cutoffTime) {
        foundOld = true;
        break; // Stop when we hit old events
      }
      
      events.unshift({ seq, ...event }); // Add to beginning to maintain order
      
      if (checked % 500 === 0) {
        process.stdout.write(`   Checked ${checked} seqs, found ${events.length} events (skipped ${skipped})...\r`);
      }
    } catch (e) {
      // Skip missing sequences
      skipped++;
    }
  }
  
  console.log(`   Checked ${checked} sequences, skipped ${skipped}`)
  
  await nc.close();
  console.log(`   Loaded ${events.length} events`);
  
  return events;
}

// Extract conversation pairs
function extractPairs(events) {
  const pairs = [];
  
  // Group by session (using our helper function)
  const sessions = {};
  for (const event of events) {
    const sessionId = extractSessionId(event);
    if (!sessions[sessionId]) sessions[sessionId] = [];
    sessions[sessionId].push(event);
  }
  
  console.log(`   Found ${Object.keys(sessions).length} sessions`);
  
  // Debug: show session sizes
  const sessionSizes = Object.entries(sessions)
    .map(([id, events]) => ({ id: id.slice(0, 20), count: events.length }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 5);
  console.log(`   Top sessions: ${sessionSizes.map(s => `${s.id}...(${s.count})`).join(', ')}`);
  
  let debugCount = 0;
  
  for (const [sessionId, sessionEvents] of Object.entries(sessions)) {
    // Sort by sequence
    sessionEvents.sort((a, b) => a.seq - b.seq);
    
    // Count event types in this session
    const typeCount = {};
    for (const e of sessionEvents) {
      typeCount[e.type] = (typeCount[e.type] || 0) + 1;
    }
    
    // Only process sessions that have both in and out messages
    if (!typeCount['conversation.message.in'] || !typeCount['conversation.message.out']) {
      continue;
    }
    
    // Debug first session
    if (debugCount === 0) {
      console.log(`\n   Debug session ${sessionId.slice(0, 30)}...`);
      console.log(`   Types: ${JSON.stringify(typeCount)}`);
    }
    
    // Find user→assistant pairs
    for (let i = 0; i < sessionEvents.length - 1; i++) {
      const userEvent = sessionEvents[i];
      const userText = extractUserText(userEvent);
      if (!userText) continue;
      
      // Debug first user message
      if (debugCount === 0) {
        console.log(`   Found user msg at i=${i}: "${userText.slice(0, 50)}..."`);
        debugCount++;
      }
      
      // Find next assistant response - get the LONGEST text (final streaming chunk)
      let assistantText = null;
      let bestAssistantLen = 0;
      let j = i + 1;
      let lastJ = j;
      
      // Scan through all subsequent message.out events until we hit another message.in
      while (j < sessionEvents.length) {
        if (sessionEvents[j].type === 'conversation.message.in') {
          break; // Stop at next user message
        }
        
        const text = extractAssistantText(sessionEvents[j]);
        if (text && text.length > bestAssistantLen) {
          assistantText = text;
          bestAssistantLen = text.length;
          lastJ = j;
        }
        j++;
      }
      
      if (!assistantText || assistantText.length < 50) continue; // Skip very short responses
      
      // Check for follow-up (next user message after the assistant response)
      let followUp = null;
      // j is now at either the next message.in or end of events
      if (j < sessionEvents.length && sessionEvents[j].type === 'conversation.message.in') {
        followUp = extractUserText(sessionEvents[j]);
      }
      
      // Calculate quality
      const quality = calculateQuality(userText, assistantText, followUp);
      
      pairs.push({
        sessionId,
        agent: userEvent.agent || 'main',
        userSeq: userEvent.seq,
        assistantSeq: sessionEvents[lastJ]?.seq || 0,
        user: userText,
        assistant: assistantText,
        followUp,
        quality,
        timestamp: userEvent.timestamp || userEvent.ts,
      });
    }
  }
  
  return pairs;
}

// Convert to OpenAI fine-tuning format
function toOpenAIFormat(pairs, systemPrompt) {
  return pairs.map(p => ({
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: p.user },
      { role: 'assistant', content: p.assistant },
    ]
  }));
}

// Convert to Alpaca format (for local LoRA)
function toAlpacaFormat(pairs) {
  return pairs.map(p => ({
    instruction: p.user,
    input: '',
    output: p.assistant,
  }));
}

// Main
async function main() {
  if (!existsSync(OUTPUT_DIR)) {
    mkdirSync(OUTPUT_DIR, { recursive: true });
  }
  
  const events = await fetchEvents(HOURS);
  const allPairs = extractPairs(events);
  
  console.log(`\n📊 Extracted ${allPairs.length} conversation pairs`);
  
  // Filter by quality
  const qualityPairs = allPairs.filter(p => p.quality >= MIN_QUALITY);
  console.log(`   ${qualityPairs.length} pairs meet quality threshold (>=${MIN_QUALITY})`);
  
  // Sort by quality
  qualityPairs.sort((a, b) => b.quality - a.quality);
  
  // Quality distribution
  const excellent = qualityPairs.filter(p => p.quality >= 0.8).length;
  const good = qualityPairs.filter(p => p.quality >= 0.6 && p.quality < 0.8).length;
  const acceptable = qualityPairs.filter(p => p.quality >= MIN_QUALITY && p.quality < 0.6).length;
  
  console.log(`\n📈 Quality Distribution:`);
  console.log(`   Excellent (≥0.8): ${excellent}`);
  console.log(`   Good (0.6-0.8): ${good}`);
  console.log(`   Acceptable (${MIN_QUALITY}-0.6): ${acceptable}`);
  
  // Sample top pairs
  console.log(`\n📝 Top 3 pairs by quality:`);
  for (const p of qualityPairs.slice(0, 3)) {
    console.log(`\n   [Quality: ${p.quality.toFixed(2)}]`);
    console.log(`   User: ${p.user.slice(0, 100)}...`);
    console.log(`   Assistant: ${p.assistant.slice(0, 100)}...`);
  }
  
  // Read system prompt for context
  const soulPath = join(CLAWD_DIR, 'SOUL.md');
  const systemPrompt = existsSync(soulPath) 
    ? readFileSync(soulPath, 'utf-8').slice(0, 2000) 
    : 'You are Claudia, a helpful AI assistant.';
  
  // Generate output files
  const timestamp = new Date().toISOString().split('T')[0];
  
  // OpenAI JSONL format
  const openaiData = toOpenAIFormat(qualityPairs, systemPrompt);
  const openaiPath = join(OUTPUT_DIR, `openai-${timestamp}.jsonl`);
  writeFileSync(openaiPath, openaiData.map(d => JSON.stringify(d)).join('\n'));
  console.log(`\n✅ OpenAI format: ${openaiPath}`);
  
  // Alpaca JSON format
  const alpacaData = toAlpacaFormat(qualityPairs);
  const alpacaPath = join(OUTPUT_DIR, `alpaca-${timestamp}.json`);
  writeFileSync(alpacaPath, JSON.stringify(alpacaData, null, 2));
  console.log(`✅ Alpaca format: ${alpacaPath}`);
  
  // Stats file
  const statsPath = join(OUTPUT_DIR, `stats-${timestamp}.json`);
  writeFileSync(statsPath, JSON.stringify({
    timestamp: new Date().toISOString(),
    hoursAnalyzed: HOURS,
    totalEvents: events.length,
    totalPairs: allPairs.length,
    qualityPairs: qualityPairs.length,
    minQuality: MIN_QUALITY,
    distribution: { excellent, good, acceptable },
    avgQuality: qualityPairs.reduce((s, p) => s + p.quality, 0) / qualityPairs.length,
    agentBreakdown: Object.entries(
      qualityPairs.reduce((acc, p) => {
        acc[p.agent] = (acc[p.agent] || 0) + 1;
        return acc;
      }, {})
    ),
  }, null, 2));
  console.log(`✅ Stats: ${statsPath}`);
  
  // Token estimation (rough)
  const totalChars = qualityPairs.reduce((s, p) => s + p.user.length + p.assistant.length, 0);
  const estimatedTokens = Math.round(totalChars / 4);
  
  console.log(`\n💰 Estimated training cost (OpenAI gpt-4o-mini):`);
  console.log(`   ~${estimatedTokens.toLocaleString()} tokens`);
  console.log(`   ~$${(estimatedTokens * 0.000003 * 3).toFixed(2)} (3 epochs)`);
  
  console.log(`\n✅ Training data extraction complete!`);
}

main().catch(e => {
  console.error('Extraction failed:', e);
  process.exit(1);
});
