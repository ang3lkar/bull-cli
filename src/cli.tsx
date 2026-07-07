#!/usr/bin/env node
import { render } from 'ink';
import meow from 'meow';
import { resolvePrefix, resolveRedisUrl } from './config.js';
import { createAltScreen } from './terminal.js';
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

// Entered after the TTY guard (so the non-TTY error above prints on the main
// screen, not inside an alt buffer nobody sees) and before `render()`, so
// the very first frame already draws in the alternate buffer.
const altScreen = createAltScreen(process.stdout);
altScreen.enter();

// Backstop: never leave the terminal stuck in the alt buffer, whatever exit
// path fires. 'exit' handlers may only do sync work — leave() is one sync
// write, and idempotent so double-firing (e.g. after shutdown() already
// called it) is fine.
process.on('exit', () => {
  altScreen.leave();
});

// On a crash, restore the main screen BEFORE printing the error — otherwise
// the stack trace lands in the alt buffer and vanishes the moment it's
// restored, leaving no clue why the process died.
function onFatal(error: unknown): void {
  altScreen.leave();
  console.error(error);
  process.exit(1);
}
process.on('uncaughtException', onFatal);
process.on('unhandledRejection', onFatal);

const app = createApp(redisUrl, prefix);

let shuttingDown = false;

function onQuit(): void {
  void shutdown();
}

const instance = render(<App store={app.store} onQuit={onQuit} />);

// Ink's default `exitOnCtrlC` intercepts Ctrl+C itself and unmounts on its
// own — `useInput` (used by `useKeymap`) puts stdin in raw mode, so Ctrl+C
// never raises SIGINT and our `SIGINT` handler below never fires. Without
// this, Ink's own unmount would skip `shutdown()` entirely: `app.stop()`
// never runs and its poll timers keep the process alive, hanging silently
// behind a (now-restored) prompt. Routing Ink's exit through `onQuit` fixes
// that; the `shuttingDown` guard in `shutdown()` makes this a no-op on every
// other exit path, where `shutdown()` already triggered the unmount itself.
void instance.waitUntilExit().then(onQuit);

async function shutdown(): Promise<void> {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  // Ink writes its final frame (and shows the cursor) INSIDE the alt
  // buffer on unmount — only after that do we switch back, discarding that
  // buffer. Reversing this order would splatter the final frame onto the
  // restored shell instead of leaving it untouched. (The cursor-show lands
  // in the discarded buffer too, but that's harmless: cursor visibility is
  // a terminal mode, not buffer content, and `restore-cursor`'s own exit
  // hook re-shows it regardless.)
  instance.unmount();
  altScreen.leave();
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
