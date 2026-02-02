#!/usr/bin/env node
/**
 * Migrate existing OpenClaw memory to NATS Event Store.
 * 
 * This script imports:
 * - Daily notes (memory/*.md)
 * - Long-term memory (MEMORY.md)
 * - Knowledge graph entries (if present)
 * 
 * Usage:
 *   node scripts/migrate-to-eventstore.mjs [options]
 * 
 * Options:
 *   --nats-url     NATS connection URL (default: nats://localhost:4222)
 *   --stream       Stream name (default: openclaw-events)
 *   --prefix       Subject prefix (default: openclaw.events)
 *   --workspace    Workspace directory (default: current directory)
 *   --dry-run      Show what would be migrated without actually doing it
 * 
 * Examples:
 *   node scripts/migrate-to-eventstore.mjs
 *   node scripts/migrate-to-eventstore.mjs --workspace ~/clawd --dry-run
 *   node scripts/migrate-to-eventstore.mjs --nats-url nats://user:pass@localhost:4222
 */

import { connect, StringCodec } from 'nats';
import { readdir, readFile, stat } from 'node:fs/promises';
import { join, basename, dirname } from 'node:path';
import { existsSync } from 'node:fs';

const sc = StringCodec();

// Parse command line arguments
function parseArgs() {
  const args = process.argv.slice(2);
  const options = {
    natsUrl: 'nats://localhost:4222',
    streamName: 'openclaw-events',
    subjectPrefix: 'openclaw.events',
    workspace: process.cwd(),
    dryRun: false,
  };

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--nats-url':
        options.natsUrl = args[++i];
        break;
      case '--stream':
        options.streamName = args[++i];
        break;
      case '--prefix':
        options.subjectPrefix = args[++i];
        break;
      case '--workspace':
        options.workspace = args[++i];
        break;
      case '--dry-run':
        options.dryRun = true;
        break;
      case '--help':
        console.log(`
Usage: node scripts/migrate-to-eventstore.mjs [options]

Options:
  --nats-url     NATS connection URL (default: nats://localhost:4222)
  --stream       Stream name (default: openclaw-events)
  --prefix       Subject prefix (default: openclaw.events)
  --workspace    Workspace directory (default: current directory)
  --dry-run      Show what would be migrated without actually doing it
`);
        process.exit(0);
    }
  }

  return options;
}

function generateEventId() {
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).substring(2, 10);
  return `${timestamp}-${random}`;
}

function parseDate(filename) {
  const match = filename.match(/(\d{4}-\d{2}-\d{2})/);
  if (match) {
    return new Date(match[1]).getTime();
  }
  return Date.now();
}

async function* findMarkdownFiles(dir, pattern = /\.md$/) {
  if (!existsSync(dir)) return;
  
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory() && !entry.name.startsWith('.')) {
      yield* findMarkdownFiles(path, pattern);
    } else if (entry.isFile() && pattern.test(entry.name)) {
      yield path;
    }
  }
}

async function migrateFile(filePath, workspace, options) {
  const content = await readFile(filePath, 'utf-8');
  const relativePath = filePath.replace(workspace, '').replace(/^\//, '');
  const filename = basename(filePath);
  const timestamp = parseDate(filename);
  
  const events = [];
  
  // Determine event type based on file location
  let eventType = 'memory';
  if (relativePath.includes('memory/')) {
    eventType = 'daily-note';
  } else if (filename === 'MEMORY.md') {
    eventType = 'long-term-memory';
  } else if (relativePath.includes('areas/people/')) {
    eventType = 'person';
  } else if (relativePath.includes('areas/companies/')) {
    eventType = 'company';
  } else if (relativePath.includes('areas/projects/')) {
    eventType = 'project';
  }
  
  // Create migration event
  events.push({
    id: generateEventId(),
    timestamp,
    agent: 'migration',
    session: 'migration:initial',
    type: `migration.${eventType}`,
    visibility: 'internal',
    payload: {
      source: relativePath,
      content: content.slice(0, 10000), // Limit content size
      contentLength: content.length,
      migratedAt: Date.now(),
    },
    meta: {
      filename,
      eventType,
    },
  });
  
  // Extract sections from the file
  const sections = content.split(/^## /m).filter(Boolean);
  for (const section of sections.slice(0, 20)) { // Limit sections
    const lines = section.split('\n');
    const title = lines[0]?.trim();
    const body = lines.slice(1).join('\n').trim();
    
    if (title && body.length > 50) {
      events.push({
        id: generateEventId(),
        timestamp: timestamp + Math.random() * 1000,
        agent: 'migration',
        session: 'migration:initial',
        type: 'migration.section',
        visibility: 'internal',
        payload: {
          source: relativePath,
          title,
          content: body.slice(0, 2000),
        },
        meta: {
          filename,
          eventType,
        },
      });
    }
  }
  
  return events;
}

async function main() {
  const options = parseArgs();
  
  console.log('OpenClaw Event Store Migration');
  console.log('==============================');
  console.log(`Workspace: ${options.workspace}`);
  console.log(`NATS URL: ${options.natsUrl}`);
  console.log(`Stream: ${options.streamName}`);
  console.log(`Dry run: ${options.dryRun}`);
  console.log('');
  
  // Collect files to migrate
  const files = [];
  const memoryDir = join(options.workspace, 'memory');
  const memoryFile = join(options.workspace, 'MEMORY.md');
  const knowledgeDir = join(options.workspace, 'life', 'areas');
  
  // Memory directory
  for await (const file of findMarkdownFiles(memoryDir)) {
    files.push(file);
  }
  
  // MEMORY.md
  if (existsSync(memoryFile)) {
    files.push(memoryFile);
  }
  
  // Knowledge graph
  for await (const file of findMarkdownFiles(knowledgeDir)) {
    files.push(file);
  }
  
  console.log(`Found ${files.length} files to migrate`);
  
  if (files.length === 0) {
    console.log('No files found. Nothing to migrate.');
    process.exit(0);
  }
  
  // Collect all events
  const allEvents = [];
  for (const file of files) {
    const events = await migrateFile(file, options.workspace, options);
    allEvents.push(...events);
    console.log(`  ${file.replace(options.workspace, '')}: ${events.length} events`);
  }
  
  console.log(`\nTotal events: ${allEvents.length}`);
  
  if (options.dryRun) {
    console.log('\nDry run - no events published.');
    console.log('Sample event:');
    console.log(JSON.stringify(allEvents[0], null, 2));
    process.exit(0);
  }
  
  // Connect to NATS and publish
  console.log('\nConnecting to NATS...');
  
  let nc;
  try {
    // Parse URL for credentials
    const httpUrl = options.natsUrl.replace(/^nats:\/\//, 'http://');
    const url = new URL(httpUrl);
    const connOpts = {
      servers: `${url.hostname}:${url.port || 4222}`,
    };
    if (url.username && url.password) {
      connOpts.user = decodeURIComponent(url.username);
      connOpts.pass = decodeURIComponent(url.password);
    }
    
    nc = await connect(connOpts);
    console.log('Connected!');
  } catch (e) {
    console.error(`Failed to connect: ${e.message}`);
    process.exit(1);
  }
  
  const js = nc.jetstream();
  const jsm = await nc.jetstreamManager();
  
  // Ensure stream exists
  try {
    await jsm.streams.info(options.streamName);
    console.log(`Stream ${options.streamName} exists`);
  } catch {
    console.log(`Creating stream ${options.streamName}...`);
    await jsm.streams.add({
      name: options.streamName,
      subjects: [`${options.subjectPrefix}.>`],
      retention: 'limits',
      storage: 'file',
      max_age: 90 * 24 * 60 * 60 * 1000000000, // 90 days in nanoseconds
    });
  }
  
  // Publish events
  console.log('\nPublishing events...');
  let published = 0;
  let errors = 0;
  
  for (const event of allEvents) {
    const subject = `${options.subjectPrefix}.${event.type}`;
    try {
      await js.publish(subject, sc.encode(JSON.stringify(event)));
      published++;
      if (published % 100 === 0) {
        process.stdout.write(`\r  Published: ${published}/${allEvents.length}`);
      }
    } catch (e) {
      errors++;
      console.error(`\n  Error publishing: ${e.message}`);
    }
  }
  
  console.log(`\n\nMigration complete!`);
  console.log(`  Published: ${published}`);
  console.log(`  Errors: ${errors}`);
  
  await nc.drain();
  process.exit(errors > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
