---
description: Prime with foundational context for the fusion-harness Pi extension repo
---

# Purpose

Orient yourself in fusion-harness: a clean-room Pi coding-agent extension that fuses two
frontier models (ARCHITECT plans/fuses/validates, BUILDER builds) behind three slash
commands, with a strict two-column output DX.

## Workflow

1. Run `git ls-files | sort` to see the full tree
2. Read `README.md` for the repo-level overview — it covers the commands, flags, host-as-builder architecture, gate loop, and the two-column DX contract
3. Note `extensions/fusion-harness/` is RUNTIME ONLY: the .ts plus the prompt files it loads. Docs live at the root README
4. Read `justfile` for the run recipes and model configuration (WORKHORSE test pair vs SOTA fable/sol pair)
5. Glob `extensions/fusion-harness/*_PROMPT_*.md` and skim 1-2 to see how default prompts are externalized with `{{VAR}}` interpolation
6. Summarize your understanding of the project: purpose, stack, structure, key files, and entry points
