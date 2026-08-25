# Issue tracker: Local Markdown

Anvil BUILD uses the repository-local Markdown tracker.

## Storage layout

- One feature per directory: `.scratch/<feature-slug>/`
- The implementation specification: `.scratch/<feature-slug>/spec.md`
- One development ticket per file: `.scratch/<feature-slug>/issues/<NN>-<slug>.md`
- Ticket numbers start at `01` and are ordered blockers-first.

## Publishing tickets

When a skill asks to publish tickets, create one Markdown file per ticket under
`.scratch/<feature-slug>/issues/`. Do not publish GitHub issues and do not combine
multiple tickets into one file.

Each ticket must use this shape:

```markdown
# <NN>: <Ticket title>

**What to build:** <end-to-end user-visible result>

**Blocked by:** <blocking ticket numbers/titles, or None (can start immediately)>

**Status:** ready-for-agent

- [ ] Acceptance criterion 1
- [ ] Acceptance criterion 2
```

A ticket is ready when every ticket listed in `Blocked by` has completed.
