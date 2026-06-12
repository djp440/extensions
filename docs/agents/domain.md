# Domain Docs

How the engineering skills should consume this repo's domain documentation when exploring the codebase.

## Before exploring, read these

- **`CONTEXT-MAP.md`** at the repo root — it points at one `CONTEXT.md` per plugin. Read each one relevant to the topic.
- **`CONTEXT.md`** within the specific plugin directory being worked on.
- **`docs/adr/`** — read ADRs that touch the area you're about to work in. In multi-context repos, also check `src/<context>/docs/adr/` for context-scoped decisions.

If any of these files don't exist, **proceed silently**. Don't flag their absence; don't suggest creating them upfront. The producer skill (`/grill-with-docs`) creates them lazily when terms or decisions actually get resolved.

## File structure (multi-context)

This repo uses a **multi-context** layout because it houses multiple pi extensions/plugins:

```
/
├── AGENTS.md
├── CONTEXT-MAP.md              ← points to per-plugin CONTEXT.md files
├── docs/
│   ├── adr/                    ← shared/cross-plugin decisions
│   └── agents/                 ← this skill's config files
├── plan.ts                     ← plugin A
├── plan-dock.ts                ← plugin B
└── <future-plugin-dir>/
    ├── CONTEXT.md
    └── docs/adr/               ← plugin-specific decisions
```

Each plugin that warrants its own context gets its own `CONTEXT.md` in the plugin's directory (or at the root for top-level files like `plan.ts` / `plan-dock.ts`).

## Use the glossary's vocabulary

When your output names a domain concept (in an issue title, a refactor proposal, a hypothesis, a test name), use the term as defined in the relevant `CONTEXT.md`. Don't drift to synonyms the glossary explicitly avoids.

If the concept you need isn't in the glossary yet, that's a signal — either you're inventing language the project doesn't use (reconsider) or there's a real gap (note it for `/grill-with-docs`).

## Flag ADR conflicts

If your output contradicts an existing ADR, surface it explicitly rather than silently overriding:

> _Contradicts ADR-0007 (event-sourced orders) — but worth reopening because…_
