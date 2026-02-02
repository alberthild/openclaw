# Event Store Integration

OpenClaw can persist all agent events to NATS JetStream, enabling event-sourced memory, audit trails, and multi-agent knowledge sharing.

## Overview

When enabled, every interaction becomes an immutable event:
- User/assistant messages
- Tool calls and results
- Session lifecycle (start/end)
- Custom events from extensions

Events are stored in NATS JetStream and can be:
- Queried for context building
- Replayed for debugging
- Shared across agents (with isolation)
- Used for continuous learning

## Configuration

Add to your `config.yml`:

```yaml
gateway:
  eventStore:
    enabled: true
    url: nats://localhost:4222
    streamName: openclaw-events
    subjectPrefix: openclaw.events
```

### Full Options

```yaml
gateway:
  eventStore:
    enabled: true                          # Enable event publishing
    url: nats://user:pass@localhost:4222   # NATS connection URL
    streamName: openclaw-events            # JetStream stream name
    subjectPrefix: openclaw.events         # Subject prefix for events
    
    # Multi-agent configuration (optional)
    agents:
      my-agent:
        url: nats://agent:pass@localhost:4222
        streamName: events-my-agent
        subjectPrefix: openclaw.events.my-agent
```

## Event Types

| Type | Description |
|------|-------------|
| `conversation.message.out` | Messages sent to/from the model |
| `conversation.tool_call` | Tool invocations |
| `conversation.tool_result` | Tool results |
| `lifecycle.start` | Session started |
| `lifecycle.end` | Session ended |

## Event Schema

```typescript
interface OpenClawEvent {
  id: string;           // Unique event ID
  timestamp: number;    // Unix milliseconds
  agent: string;        // Agent identifier
  session: string;      // Session key
  type: string;         // Event type
  visibility: string;   // 'internal' | 'public'
  payload: {
    runId: string;      // Current run ID
    stream: string;     // Event stream type
    data: any;          // Event-specific data
    sessionKey: string;
    seq: number;        // Sequence in run
    ts: number;
  };
  meta: {
    runId: string;
    seq: number;
    model?: string;
    channel?: string;
  };
}
```

## Context Injection

When event store is enabled, OpenClaw automatically:

1. Queries recent events on session start
2. Extracts conversation history and topics
3. Injects context into the system prompt

This gives the agent memory of recent interactions without manual file management.

### Context Format

The injected context includes:
- Recent conversation snippets (deduplicated)
- Active topics mentioned
- Event count and timeframe

## Multi-Agent Isolation

For multi-agent setups, each agent can have its own stream:

```yaml
gateway:
  eventStore:
    enabled: true
    url: nats://main:password@localhost:4222
    streamName: openclaw-events
    subjectPrefix: openclaw.events.main
    
    agents:
      assistant-one:
        url: nats://assistant1:pass@localhost:4222
        streamName: events-assistant-one
        subjectPrefix: openclaw.events.assistant-one
      assistant-two:
        url: nats://assistant2:pass@localhost:4222
        streamName: events-assistant-two
        subjectPrefix: openclaw.events.assistant-two
```

Combined with NATS account permissions, this ensures agents can only read their own events.

## NATS Setup

### Quick Start (Docker)

```bash
docker run -d --name nats \
  -p 4222:4222 \
  -v nats-data:/data \
  nats:latest \
  -js -sd /data
```

### Create Stream

```bash
nats stream add openclaw-events \
  --subjects "openclaw.events.>" \
  --storage file \
  --retention limits \
  --max-age 90d
```

### Secure Setup (Multi-Agent)

See [NATS Security Documentation](https://docs.nats.io/running-a-nats-service/configuration/securing_nats) for setting up accounts and permissions.

Example secure config:
```
accounts {
  AGENTS: {
    jetstream: enabled
    users: [
      { user: main, password: "xxx", permissions: { publish: [">"], subscribe: [">"] } },
      { user: agent1, password: "xxx", permissions: { 
          publish: ["openclaw.events.agent1.>", "$JS.API.>", "_INBOX.>"],
          subscribe: ["openclaw.events.agent1.>", "_INBOX.>", "$JS.API.>"]
      }}
    ]
  }
}
```

## Migration

To migrate existing memory files to the event store:

```bash
# Install dependencies
npm install nats

# Run migration
node scripts/migrate-to-eventstore.mjs
```

The migration script imports:
- Daily notes (`memory/*.md`)
- Long-term memory (`MEMORY.md`)
- Knowledge graph entries (`life/areas/`)

## Querying Events

### Via NATS CLI

```bash
# List streams
nats stream ls

# Get stream info
nats stream info openclaw-events

# Read recent events
nats consumer add openclaw-events reader --deliver last --ack none
nats consumer next openclaw-events reader --count 10
```

### Programmatically

```typescript
import { connect, StringCodec } from 'nats';

const nc = await connect({ servers: 'localhost:4222' });
const js = nc.jetstream();
const jsm = await nc.jetstreamManager();

// Get last 100 events
const info = await jsm.streams.info('openclaw-events');
for (let seq = info.state.last_seq - 100; seq <= info.state.last_seq; seq++) {
  const msg = await jsm.streams.getMessage('openclaw-events', { seq });
  const event = JSON.parse(StringCodec().decode(msg.data));
  console.log(event.type, event.timestamp);
}
```

## Best Practices

1. **Retention Policy**: Set appropriate max-age for your use case (default: 90 days)
2. **Stream per Agent**: Use separate streams for agent isolation
3. **Backup**: Configure NATS replication or backup JetStream data directory
4. **Monitoring**: Use NATS monitoring endpoints to track stream health

## Troubleshooting

### Events not appearing

1. Check NATS connection: `nats server ping`
2. Verify stream exists: `nats stream ls`
3. Check OpenClaw logs for connection errors
4. Ensure `eventStore.enabled: true` in config

### Context not loading

1. Verify events exist in stream
2. Check NATS credentials have read permission
3. Look for errors in OpenClaw startup logs

### Performance issues

1. Limit event retention with `--max-age`
2. Use separate streams for high-volume agents
3. Consider NATS clustering for scale
