const ENTER_ALT_SCREEN = '\x1b[?1049h';
const LEAVE_ALT_SCREEN = '\x1b[?1049l';

/** Minimal surface `createAltScreen` needs — lets tests inject a fake in place of `process.stdout`. */
export interface AltScreenStream {
  write(data: string): unknown;
}

export interface AltScreen {
  enter(): void;
  /** Idempotent — shutdown(), process.on('exit') and crash handlers may all fire on one exit. */
  leave(): void;
}

/**
 * Alternate screen buffer helper (`\x1b[?1049h`/`l`) — this is what gives the
 * dashboard vim/htop behavior: it draws in a separate buffer that the
 * terminal discards on `leave()`, restoring the shell (and scrollback)
 * exactly as it was. Ink 6.8 has no built-in option for this, so we emit the
 * escapes ourselves; it's two string writes, no new dependency.
 *
 * Deliberately does NOT touch cursor visibility — Ink already hides the
 * cursor on first render and restores it on unmount and even on crash (via
 * `cli-cursor`/`restore-cursor`'s own exit hooks). Emitting `\x1b[?25l`/`h`
 * here too would double-manage it.
 *
 * `enter`/`leave` are idempotent (tracked via `active`) because the caller
 * may need to call `leave()` from several independent exit paths (normal
 * shutdown, the `process.on('exit')` backstop, crash handlers) and at most
 * one of those should actually emit the escape.
 */
export function createAltScreen(stream: AltScreenStream): AltScreen {
  let active = false;
  return {
    enter(): void {
      if (!active) {
        active = true;
        stream.write(ENTER_ALT_SCREEN);
      }
    },
    leave(): void {
      if (active) {
        active = false;
        stream.write(LEAVE_ALT_SCREEN);
      }
    },
  };
}
