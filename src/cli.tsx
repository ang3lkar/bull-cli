#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { performance } from 'node:perf_hooks';
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
import { doctorExitCode, formatDoctorReport, runDoctor } from './core/doctor.js';
import { createDoctorRedisClient } from './core/redis.js';
import { dumpQueuesJson } from './jsonOutput.js';
import { parseRetryArgs, retryExitCode, runRetry } from './retryCommand.js';
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
	  $ bull-cli doctor [options]
	  $ bull-cli retry --queue <name> (--dry-run | --yes) [options]

	Commands
	  doctor             Diagnose config, connection and queue discovery (supports --output json)
	  retry              Retry failed jobs and print a JSON summary (exits 1 if any retry failed)

	Options
	  --redis <url>      Redis connection URL (overrides REDIS_URL env var)
	  --prefix <prefix>  BullMQ key prefix (overrides BULLMQ_PREFIX env var, default "bull")
	  --output <format>  Output mode (supported: json)
	  --queue <name>     Queue filter for --output=json; the queue to act on for retry
	  --job-id <id>      retry: only this failed job
	  --since <duration> retry: only jobs that failed within this window (30s, 15m, 2h, 7d, 1w)
	  --dry-run          retry: report what would be retried without changing anything
	  --yes              retry: actually retry (retry refuses to run without --dry-run or --yes)
	  -h, --help         Show help
	  -v, --version      Show version

	Examples
	  $ bull-cli --redis redis://localhost:6379
	  $ bull-cli --prefix myapp
	  $ bull-cli --output json
	  $ bull-cli --output json --queue email
	  $ bull-cli doctor
	  $ bull-cli doctor --output json
	  $ bull-cli retry --queue email --dry-run
	  $ bull-cli retry --queue email --since 2h --yes
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
      jobId: {
        type: 'string',
      },
      since: {
        type: 'string',
      },
      dryRun: {
        type: 'boolean',
      },
      yes: {
        type: 'boolean',
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

/**
 * `bull-cli doctor`: never needs a TTY or the alt screen, and runs before the
 * fail-fast config loading below — a broken config file is reported as a
 * failed check instead of exiting early. All logic lives in core/doctor.ts.
 */
async function runDoctorCommand(): Promise<never> {
  if (cli.flags.queue !== undefined) {
    console.error("Error: --queue isn't supported with doctor");
    process.exit(1);
  }
  if (cli.flags.output !== undefined && cli.flags.output !== 'json') {
    console.error(`Error: unsupported --output value "${cli.flags.output}" (supported: json)`);
    process.exit(1);
  }
  const report = await runDoctor({
    redisFlag: cli.flags.redis,
    prefixFlag: cli.flags.prefix,
    env: process.env,
    configPaths: {
      user: userConfigPath(process.env, homedir()),
      project: projectConfigPath(process.cwd()),
    },
    fileExists: existsSync,
    readFile: (path) => readFileSync(path, 'utf8'),
    createClient: createDoctorRedisClient,
    now: () => performance.now(),
    version: cli.pkg.version ?? '0.0.0',
  });
  const text =
    cli.flags.output === 'json' ? JSON.stringify(report, null, 2) : formatDoctorReport(report);
  process.stdout.write(`${text}\n`, () => process.exit(doctorExitCode(report)));
  // Keep the promise pending until the write callback exits the process.
  return new Promise<never>(() => {});
}

/**
 * `bull-cli retry`: headless, no TTY needed. Parsing and the run itself live
 * in retryCommand.ts; this only resolves the connection and exits with the
 * report's code once the JSON has been flushed.
 */
async function runRetryCommand(extra: string[]): Promise<never> {
  const parsed = parseRetryArgs(extra, cli.flags);
  if (!parsed.ok) {
    console.error(`Error: ${parsed.error}`);
    process.exit(1);
  }
  const report = await runRetry(parsed.options, {
    redisUrl: resolveRedisUrl(cli.flags.redis, process.env),
    prefix: resolvePrefix(cli.flags.prefix, process.env),
    now: () => Date.now(),
  });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`, () =>
    process.exit(retryExitCode(report)),
  );
  // Keep the promise pending until the write callback exits the process.
  return new Promise<never>(() => {});
}

async function main(): Promise<void> {
  const [command, ...extra] = cli.input;
  if (command === 'retry') {
    await runRetryCommand(extra);
  }
  const { jobId, since, dryRun, yes } = cli.flags;
  if (jobId !== undefined || since !== undefined || dryRun || yes) {
    console.error('Error: --job-id, --since, --dry-run and --yes only work with the retry command');
    process.exit(1);
  }
  if (command === 'doctor' && extra.length > 0) {
    console.error(`Error: unknown command "${cli.input.join(' ')}"`);
    process.exit(1);
  } else if (command === 'doctor') {
    await runDoctorCommand();
  } else if (command !== undefined) {
    console.error(`Error: unknown command "${command}"`);
    process.exit(1);
  }

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
