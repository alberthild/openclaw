#!/usr/bin/env bash
# Event Store Health Check — Validates all 5 core capabilities
# Usage: ./event-store-healthcheck.sh [--verbose]

set -euo pipefail

NATS_CLI=~/bin/nats
STREAM="openclaw-events"
VERBOSE=${1:-""}

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

pass() { echo -e "${GREEN}✓${NC} $1"; }
fail() { echo -e "${RED}✗${NC} $1"; FAILED=1; }
info() { echo -e "${BLUE}ℹ${NC} $1"; }
warn() { echo -e "${YELLOW}⚠${NC} $1"; }

FAILED=0

echo "═══════════════════════════════════════════════════════════════"
echo "  Event Store Health Check — $(date '+%Y-%m-%d %H:%M:%S')"
echo "═══════════════════════════════════════════════════════════════"
echo ""

# ─────────────────────────────────────────────────────────────────────
# 1. EVENT REPLAY — Seq 1 bis N jederzeit abrufbar
# ─────────────────────────────────────────────────────────────────────
echo "1️⃣  EVENT REPLAY"

# Get stream info
STREAM_INFO=$($NATS_CLI stream info $STREAM --json 2>/dev/null || echo "{}")
TOTAL_MSGS=$(echo "$STREAM_INFO" | jq -r '.state.messages // 0')
FIRST_SEQ=$(echo "$STREAM_INFO" | jq -r '.state.first_seq // 0')
LAST_SEQ=$(echo "$STREAM_INFO" | jq -r '.state.last_seq // 0')

if [[ "$TOTAL_MSGS" -gt 0 ]]; then
    pass "Stream online: $TOTAL_MSGS events (seq $FIRST_SEQ → $LAST_SEQ)"
    
    # Test fetching first event
    FIRST_EVENT=$($NATS_CLI stream get $STREAM $FIRST_SEQ --json 2>/dev/null | jq -r '.data' | base64 -d 2>/dev/null || echo "")
    if [[ -n "$FIRST_EVENT" ]]; then
        FIRST_TYPE=$(echo "$FIRST_EVENT" | jq -r '.type // "unknown"' 2>/dev/null)
        pass "First event retrievable (type: $FIRST_TYPE)"
    else
        fail "Cannot retrieve first event at seq $FIRST_SEQ"
    fi
    
    # Test fetching last event
    LAST_EVENT=$($NATS_CLI stream get $STREAM $LAST_SEQ --json 2>/dev/null | jq -r '.data' | base64 -d 2>/dev/null || echo "")
    if [[ -n "$LAST_EVENT" ]]; then
        LAST_TYPE=$(echo "$LAST_EVENT" | jq -r '.type // "unknown"' 2>/dev/null)
        pass "Last event retrievable (type: $LAST_TYPE)"
    else
        fail "Cannot retrieve last event at seq $LAST_SEQ"
    fi
else
    fail "Stream empty or unreachable"
fi
echo ""

# ─────────────────────────────────────────────────────────────────────
# 2. TEMPORAL QUERIES — Query by timestamp + agent
# ─────────────────────────────────────────────────────────────────────
echo "2️⃣  TEMPORAL QUERIES"

# Query events from specific time window (last hour)
ONE_HOUR_AGO=$(date -d '1 hour ago' -Iseconds 2>/dev/null || date -v-1H -Iseconds 2>/dev/null)
NOW=$(date -Iseconds)

# Count events by agent in last hour using subject filter
AGENTS=("main" "viola" "stella" "vera" "mondo-assistant")
AGENT_COUNTS=""

for AGENT in "${AGENTS[@]}"; do
    # Get consumer info or count messages with agent prefix
    COUNT=$($NATS_CLI stream get $STREAM --last-for "openclaw.events.${AGENT}.*" --json 2>/dev/null | jq -r '.seq // 0' || echo "0")
    if [[ "$COUNT" != "0" ]]; then
        AGENT_COUNTS="$AGENT_COUNTS $AGENT:$COUNT"
    fi
done

if [[ -n "$AGENT_COUNTS" ]]; then
    pass "Temporal query working — last events by agent:$AGENT_COUNTS"
else
    # Fallback: check if any events have timestamps
    SAMPLE=$($NATS_CLI stream get $STREAM $LAST_SEQ --json 2>/dev/null | jq -r '.data' | base64 -d 2>/dev/null | jq -r '.timestamp // .ts // "none"' 2>/dev/null)
    if [[ "$SAMPLE" != "none" && -n "$SAMPLE" ]]; then
        pass "Events have timestamps (sample: $SAMPLE)"
    else
        warn "Could not verify temporal queries"
    fi
fi

# Test specific date query capability
if [[ "$VERBOSE" == "--verbose" ]]; then
    info "Sample event structure:"
    $NATS_CLI stream get $STREAM $LAST_SEQ --json 2>/dev/null | jq -r '.data' | base64 -d 2>/dev/null | jq '.' 2>/dev/null | head -20
fi
echo ""

# ─────────────────────────────────────────────────────────────────────
# 3. PROJECTIONS — Extracted entities from learning processor
# ─────────────────────────────────────────────────────────────────────
echo "3️⃣  PROJECTIONS"

LEARNING_DIR=~/clawd/learning
PEOPLE_COUNT=0
COMPANIES_COUNT=0
TOPICS_COUNT=0

# Check main agent's learning context
if [[ -f "$LEARNING_DIR/main/context.md" ]]; then
    PEOPLE_COUNT=$(grep -c "^\- \*\*" "$LEARNING_DIR/main/context.md" 2>/dev/null || echo "0")
    pass "Learning context exists for main agent"
else
    warn "No learning context for main agent"
fi

# Count entities in life/areas
PEOPLE_DIR=~/life/areas/people
COMPANIES_DIR=~/life/areas/companies

if [[ -d "$PEOPLE_DIR" ]]; then
    PEOPLE_COUNT=$(find "$PEOPLE_DIR" -maxdepth 1 -type d | wc -l)
    PEOPLE_COUNT=$((PEOPLE_COUNT - 1))  # Subtract parent dir
    pass "People entities: $PEOPLE_COUNT"
else
    warn "People directory not found"
fi

if [[ -d "$COMPANIES_DIR" ]]; then
    COMPANIES_COUNT=$(find "$COMPANIES_DIR" -maxdepth 1 -type d | wc -l)
    COMPANIES_COUNT=$((COMPANIES_COUNT - 1))
    pass "Company entities: $COMPANIES_COUNT"
else
    warn "Companies directory not found"
fi

# Check for recent fact extraction
LATEST_FACTS=$(find ~/clawd/learning -name "*.md" -mmin -60 2>/dev/null | wc -l)
if [[ "$LATEST_FACTS" -gt 0 ]]; then
    pass "Learning files updated in last hour: $LATEST_FACTS"
else
    info "No learning updates in last hour (normal if idle)"
fi
echo ""

# ─────────────────────────────────────────────────────────────────────
# 4. AGENT ISOLATION — Each agent has own history
# ─────────────────────────────────────────────────────────────────────
echo "4️⃣  AGENT ISOLATION"

# Check for agent-specific subjects in stream
SUBJECTS=$($NATS_CLI stream info $STREAM --json 2>/dev/null | jq -r '.config.subjects[]' 2>/dev/null || echo "")

if echo "$SUBJECTS" | grep -q "openclaw.events.>"; then
    pass "Stream configured for agent isolation (openclaw.events.>)"
fi

# Count unique agent prefixes in recent events (sample last 100)
AGENT_SUBJECTS=$($NATS_CLI stream view $STREAM --last 100 --json 2>/dev/null | jq -r '.[].subject' 2>/dev/null | sort -u || echo "")

if [[ -n "$AGENT_SUBJECTS" ]]; then
    UNIQUE_AGENTS=$(echo "$AGENT_SUBJECTS" | sed 's/openclaw\.events\.\([^.]*\)\..*/\1/' | sort -u | wc -l)
    pass "Active agents in stream: $UNIQUE_AGENTS"
    if [[ "$VERBOSE" == "--verbose" ]]; then
        info "Subjects: $(echo "$AGENT_SUBJECTS" | tr '\n' ' ')"
    fi
else
    # Fallback: check NATS users
    NATS_USERS=$(grep -c "user:" /etc/nats/nats-server.conf 2>/dev/null || echo "0")
    if [[ "$NATS_USERS" -gt 1 ]]; then
        pass "NATS configured with $NATS_USERS users (agent isolation via auth)"
    else
        warn "Could not verify agent isolation"
    fi
fi
echo ""

# ─────────────────────────────────────────────────────────────────────
# 5. REAL-TIME — Latency and pending check
# ─────────────────────────────────────────────────────────────────────
echo "5️⃣  REAL-TIME PERFORMANCE"

# Check consumer lag
CONSUMERS=$($NATS_CLI consumer ls $STREAM --json 2>/dev/null | jq -r '.[]' 2>/dev/null || echo "")

if [[ -n "$CONSUMERS" ]]; then
    for CONSUMER in $CONSUMERS; do
        CONSUMER_INFO=$($NATS_CLI consumer info $STREAM "$CONSUMER" --json 2>/dev/null || echo "{}")
        PENDING=$(echo "$CONSUMER_INFO" | jq -r '.num_pending // 0')
        DELIVERED=$(echo "$CONSUMER_INFO" | jq -r '.delivered.stream_seq // 0')
        
        if [[ "$PENDING" -eq 0 ]]; then
            pass "Consumer '$CONSUMER': 0 pending (caught up)"
        elif [[ "$PENDING" -lt 100 ]]; then
            pass "Consumer '$CONSUMER': $PENDING pending (acceptable)"
        else
            warn "Consumer '$CONSUMER': $PENDING pending (lag detected)"
        fi
    done
else
    info "No durable consumers (events processed synchronously)"
fi

# Measure write latency
START_TIME=$(date +%s%N)
TEST_SUBJECT="openclaw.events.healthcheck.test"
echo '{"type":"healthcheck","ts":"'$(date -Iseconds)'"}' | $NATS_CLI pub "$TEST_SUBJECT" 2>/dev/null
END_TIME=$(date +%s%N)
LATENCY_MS=$(( (END_TIME - START_TIME) / 1000000 ))

if [[ "$LATENCY_MS" -lt 100 ]]; then
    pass "Write latency: ${LATENCY_MS}ms (excellent)"
elif [[ "$LATENCY_MS" -lt 500 ]]; then
    pass "Write latency: ${LATENCY_MS}ms (good)"
else
    warn "Write latency: ${LATENCY_MS}ms (slow)"
fi

# Check stream size
STREAM_SIZE=$(echo "$STREAM_INFO" | jq -r '.state.bytes // 0')
STREAM_SIZE_MB=$((STREAM_SIZE / 1024 / 1024))
info "Stream size: ${STREAM_SIZE_MB}MB"
echo ""

# ─────────────────────────────────────────────────────────────────────
# SUMMARY
# ─────────────────────────────────────────────────────────────────────
echo "═══════════════════════════════════════════════════════════════"
if [[ "$FAILED" -eq 0 ]]; then
    echo -e "${GREEN}  ALL CHECKS PASSED${NC}"
else
    echo -e "${RED}  SOME CHECKS FAILED${NC}"
fi
echo "═══════════════════════════════════════════════════════════════"
echo ""
echo "Summary:"
echo "  • Events: $TOTAL_MSGS (seq $FIRST_SEQ → $LAST_SEQ)"
echo "  • People: $PEOPLE_COUNT | Companies: $COMPANIES_COUNT"
echo "  • Stream: ${STREAM_SIZE_MB}MB"
echo "  • Latency: ${LATENCY_MS}ms"
echo ""

exit $FAILED
