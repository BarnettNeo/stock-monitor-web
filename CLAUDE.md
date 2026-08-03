
## Behavioral Guidelines

1. Before coding: state assumptions, ask if unclear, surface tradeoffs.
2. Simplicity first: no extra features, no premature abstractions.
3. Surgical changes: edit only what's requested; don't "improve" adjacent code.
4. Goal-driven: define success criteria, loop until verified.

## Tool Collaboration: CodeGraph + CCTO

Two token-saving tool systems. Use them together, not in isolation.

| Scenario | Primary Tool | Why |
|---|---|---|
| Project overview, file tree | `project_outline` (CCTO) | Condensed tree with language tags |
| Find symbol definition | `codegraph_search` | AST-level, returns kind + location + signature |
| Trace call flow (X → Y) | `codegraph_trace` | One call returns full path incl. dynamic hops |
| Impact analysis | `codegraph_impact` | What breaks if I change Z? |
| Read file efficiently | `smart_read` (CCTO) | Outline first, fetch specific sections |
| Find code by description | `semantic_search` (CCTO) | e.g. `semantic_search("auth middleware")` |
| Multiple symbol source | `codegraph_explore` | Several symbols' source in one capped call |
| Recall past sessions | `memory_recall` (CCTO) | Search session summaries |
| Callers/callees of a function | `codegraph_callers` / `codegraph_callees` | Direct graph queries |

### Workflow

1. **Orient** — `project_outline` or `codegraph_context` to understand area
2. **Structure** — CodeGraph for symbol lookup, traces, impact
3. **Read** — `smart_read` for efficient file reading after knowing what to read
4. **Find** — `semantic_search` when you know intent but not symbol name
5. **Re-index** after large changes: `ccto index --incremental`

### Rules

- **CodeGraph for structure, CCTO for reading.** Don't grep to verify CodeGraph — it's AST-level, more accurate.
- **`semantic_search` first for code discovery.** Before reaching for Grep/Agent, try `semantic_search` with a Chinese or English query — it saves tokens and finds semantic matches Grep can't.
- **Don't chain `codegraph_search` + `codegraph_node`** — `codegraph_context` does both in one call.
- **Don't loop `codegraph_node` over many symbols** — `codegraph_explore` batches them.
- **Index lag**: file watcher debounces ~500ms; don't re-query immediately after editing.


# CLAUDE.md

## CCTO Token Optimization

CCTO is active in this project. Binary files (images, fonts) excluded from indexing.

### MCP Tools Available

Use these tools instead of reading files directly to save tokens:

- **`semantic_search`** — Find relevant code by description (e.g. `semantic_search("authentication middleware")`)
- **`smart_read`** — Read a file outline first, then fetch specific sections
- **`project_outline`** — Get a condensed project tree with language tags
- **`memory_recall`** — Search past session summaries


