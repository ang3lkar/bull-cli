#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { render } from 'ink';
import meow from 'meow';
import {
  ConfigError,
  parseConfigFile,
  projectConfigPath,
  resolvePrefix,
  resolveRedisUrl,
  resolveRefreshIntervalMs,
  resolveRefreshTimeoutMs,
  type UserConfig,
  userConfigPath,
} from './config.js';
import { dumpQueuesJson } from './jsonOutput.js';
import { createAltScreen } from './terminal.js';
import { App } from './ui/App.js';
import { createApp } from './wiring.js';

/**
 * Reads and validates one optional config file. A missing file is fine
 * (returns `null`); a present-but-broken one (bad syntax, unknown key,
 * invalid value) prints a stderr error and exits before the alt screen is
 * entered — same fail-fast treatment as the TTY guard below, since a
 * config file is something the user deliberately wrote and a silent
 * fallback would leave them staring at a dashboard that mysteriously
 * ignored their setting.
 */
function loadConfigFile(filePath: string): UserConfig | null {
  if (!existsSync(filePath)) {
    return null;
  }
  try {
    return parseConfigFile(readFileSync(filePath, 'utf8'), filePath);
  } catch (err) {
    console.error(err instanceof ConfigError ? err.message : String(err));
    process.exit(1);
  }
}

const cli = meow(
  `
	Usage
	  $ bull-cli [options]

	Options
	  --redis <url>      Redis connection URL (overrides REDIS_URL env var)
	  --prefix <prefix>  BullMQ key prefix (overrides BULLMQ_PREFIX env var, default "bull")
	  --output <format>  Output mode (supported: json)
	  --queue <name>     Queue filter for --output=json
	  -h, --help         Show help
	  -v, --version      Show version

	Examples
	  $ bull-cli --redis redis://localhost:6379
	  $ bull-cli --prefix myapp
	  $ bull-cli --output json
	  $ bull-cli --output json --queue email
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
      output: {
        type: 'string',
      },
      queue: {
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

async function runJsonOutputMode(redisUrl: string, prefix: string): Promise<void> {
  if (cli.flags.queue && cli.flags.output !== 'json') {
    console.error('Error: --queue requires --output=json');
    process.exit(1);
  }
  if (cli.flags.output !== undefined && cli.flags.output !== 'json') {
    console.error(`Error: unsupported --output value "${cli.flags.output}" (supported: json)`);
    process.exit(1);
  }
  if (cli.flags.output !== 'json') {
    return;
  }

  try {
    const data = await dumpQueuesJson({
      redisUrl,
      prefix,
      queueName: cli.flags.queue,
    });
    process.stdout.write(`${JSON.stringify(data, null, 2)}\n`);
    process.exit(0);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}

async function main(): Promise<void> {
  const redisUrl = resolveRedisUrl(cli.flags.redis, process.env);
  const prefix = resolvePrefix(cli.flags.prefix, process.env);

  const userConfig = loadConfigFile(userConfigPath(process.env, homedir()));
  const projectConfig = loadConfigFile(projectConfigPath(process.cwd()));
  const refreshIntervalMs = resolveRefreshIntervalMs(userConfig, projectConfig);
  const refreshTimeoutMs = resolveRefreshTimeoutMs(userConfig, projectConfig);

  await runJsonOutputMode(redisUrl, prefix);

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

  const app = createApp(redisUrl, prefix, refreshIntervalMs, refreshTimeoutMs);

  let shuttingDown = false;

  function onQuit(): void {
    void shutdown();
  }

  const instance = render(
    <App store={app.store} onQuit={onQuit} version={cli.pkg.version ?? '0.0.0'} />,
  );

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
}

void main().catch((error) => {
  console.error(error);
  process.exit(1);
});
