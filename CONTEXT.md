# bull-cli

A terminal dashboard (TUI) for BullMQ job queues. This glossary fixes the words we use for what
appears on screen, so that UI discussions don't drift between the component names in `src/ui/`
and what a user actually sees.

## Language

**Title bar**:
The top row of the screen, holding the app's identity (`bull-cli v0.1.0`) and nothing else,
with a full-width rule beneath it. It is app chrome: it never reports where you are.
_Avoid_: Header (that's the title bar and the legend together), breadcrumb bar, top bar

**Legend**:
The grid of `<key> Action` pairs below the title bar, listing the keys available in the current
view. Split into always-available keys and view-contextual ones.
_Avoid_: Shortcut header, help bar, keybinding table

**Job detail view**:
The full-screen view of a single job, pushed onto the navigation stack in place of the job list.
Not a modal — nothing renders behind or around it.
_Avoid_: Job detail modal, job overlay
