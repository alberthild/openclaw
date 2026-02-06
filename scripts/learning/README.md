# Learning Scripts

Tools for extracting training data from the Event Store and building fine-tuned models.

## Overview

These scripts enable a continuous learning pipeline:

```
Events (NATS) → Extraction → Training Data → Fine-tuned Model
                    ↑
            Feedback Analysis
```

## Scripts

### training-data-extractor.mjs

Extracts conversation pairs from NATS events for fine-tuning.

```bash
# Extract last 24 hours
node training-data-extractor.mjs 24

# Extract with quality threshold
node training-data-extractor.mjs 168 --min-quality=0.5
```

**Output:**

- `openai-YYYY-MM-DD.jsonl` — OpenAI fine-tuning format
- `alpaca-YYYY-MM-DD.json` — Alpaca format for local LoRA
- `stats-YYYY-MM-DD.json` — Extraction statistics

**Features:**

- Session matching via runId↔sessionId correlation
- Quality scoring based on response length and feedback
- Streaming chunk aggregation (finds complete responses)
- Skip patterns for system messages and heartbeats

### feedback-analyzer.mjs

Analyzes implicit feedback signals from conversations.

```bash
# Analyze last 48 hours
node feedback-analyzer.mjs 48
```

**Detects:**

- Positive signals (👍, "super", "danke", "genau")
- Negative signals (👎, "nein", "falsch")
- Correction patterns ("ich meinte...", "nicht X, sondern Y")
- Style requests ("kürzer", "auf deutsch", "mehr details")

**Output:**

- `behavior.json` — Aggregated signals and adjustments
- `behavior-context.md` — Human-readable context for system prompt

### event-store-healthcheck.sh

Validates all 5 Event Store capabilities.

```bash
./event-store-healthcheck.sh
./event-store-healthcheck.sh --verbose
```

**Checks:**

1. **Event Replay** — Can retrieve any event by sequence
2. **Temporal Queries** — Events have timestamps, agent prefixes work
3. **Projections** — Learning files are being updated
4. **Agent Isolation** — Multiple agents have separate subjects
5. **Real-time** — Consumer lag is acceptable, write latency is low

## Integration with Ollama

Create a personalized model from training data:

```bash
# 1. Extract training pairs
node training-data-extractor.mjs 168

# 2. Create Modelfile with examples
# (See training-data/Modelfile.claudia for template)

# 3. Build model
ollama create my-agent -f Modelfile
```

## Cron Integration

Run daily to accumulate training data:

```yaml
# In OpenClaw config
cron:
  - name: "Daily Training Data"
    schedule: "0 3 * * *"
    command: "node scripts/learning/training-data-extractor.mjs 24"
```

## Requirements

- Node.js 18+
- NATS CLI (`nats`) for healthcheck
- Access to NATS JetStream with event store

## Configuration

Scripts read NATS connection from environment:

```bash
export NATS_URL="nats://user:pass@localhost:4222"
```

Or modify the `NATS_URL` constant in each script.
