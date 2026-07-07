#!/usr/bin/env node
import { render } from 'ink';
import meow from 'meow';
import { resolvePrefix, resolveRedisUrl } from './config.js';
import { App } from './ui/App.js';
import { createApp } from './wiring.js';

const cli = meow(
  `
	Usage
	  $ bull-cli [options]

	Options
	  --redis <url>      Redis connection URL (overrides REDIS_URL env var)
	  --prefix <prefix>  BullMQ key prefix (overrides BULLMQ_PREFIX env var, default "bull")
	  -h, --help         Show help
	  -v, --version      Show version

	Examples
	  $ bull-cli --redis redis://localhost:6379
	  $ bull-cli --prefix myapp
`,
  {
    importMeta: import.meta,
    flags: {
      redis: {
        type: 'string',
      },
      prefix: {
        type: 'string',
      },
      help: {
        type: 'boolean',
        shortFlag: 'h',
      },
      version: {
        type: 'boolean',
        shortFlag: 'v',
      },
    },
  },
);

const redisUrl = resolveRedisUrl(cli.flags.redis, process.env);
const prefix = resolvePrefix(cli.flags.prefix, process.env);

if (!process.stdin.isTTY) {
  console.error('bull-cli requires an interactive terminal (TTY)');
  process.exit(1);
}

const app = createApp(redisUrl, prefix);

let shuttingDown = false;

function onQuit(): void {
  void shutdown();
}

const instance = render(<App store={app.store} onQuit={onQuit} />);

async function shutdown(): Promise<void> {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  instance.unmount();
  try {
    await app.stop();
  } finally {
    // Exit even if stop() rejects (e.g. a queue's close() call fails) —
    // otherwise a rejection here would surface as an unhandled rejection
    // and leave the process hanging instead of quitting cleanly.
    process.exit(0);
  }
}

process.on('SIGINT', onQuit);
process.on('SIGTERM', onQuit);

// Connection errors surface through the store (onConnectionStatus) rather
// than as a rejection here — a failed `start()` is not fatal to the CLI.
void app.start();
