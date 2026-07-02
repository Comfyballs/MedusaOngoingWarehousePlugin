<!-- superpowers-setup managed file. setup-version: 7. Do not edit by hand; re-run /init-project to update. -->
---
name: knowledge-sources
description: Use when asked why a rule or convention exists, where something is defined, or how an upstream library/API behaves. Routes the question to grep over docs, a docs MCP (Context7), or a code graph, and keeps answers cited and honest about staleness.
---

# Knowledge sources and retrieval routing

Route the question to the right source, cite it, and never guess.

## 1. Project decisions, rules, ADRs, plan-to-spec links
Use grep and Read over the repo, not a graph. Cite `file:line`.
Key files: `CLAUDE.md`, `docs/adr/`, `docs/specs/`, `docs/superpowers/plans/`.

## 2. Upstream library/API behavior
Version-exact facts (signatures, current defaults, "what changed in X"): Context7 or a project docs MCP. Fall back to the live doc page. Do not answer from memory.

## 3. Code structure / symbols
If `graphify-out/` exists, use the AST code graph (per the global graphify rule).

## Honesty rails
Cite `source_file` / `file:line` and, for graph answers, edge confidence (EXTRACTED / INFERRED / AMBIGUOUS). INFERRED edges are leads to verify, not facts. Do not invent edges.
