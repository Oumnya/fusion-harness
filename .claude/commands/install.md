---
description: Install and verify the fusion-harness toolchain (pi, just, jq, uv, API keys)
---

# Purpose

Install everything the fusion-harness needs and verify the harness launches.

## Workflow

1. Check each prerequisite binary and install the ones that are missing:
   - `pi` — `npm install -g @earendil-works/pi-coding-agent`
   - `just`, `jq`, `uv` — `brew install just jq uv` (macOS) or the user's package manager
2. Check that `.env` exists at the repo root and contains non-placeholder values for
   `ANTHROPIC_API_KEY` (architect) and `OPENAI_API_KEY` (builder). If it is missing or
   holds placeholders, ask the user for keys — never invent or commit them. Note the
   gotcha: `just`'s dotenv-load does NOT override variables already exported in the
   shell, so a stale exported key silently wins over `.env`.
3. Confirm the extension file loads by checking the entry point exists:
   `extensions/fusion-harness/fusion-harness.ts` plus its sibling `SYSTEM_PROMPT_*.md`
   and `USER_PROMPT_*.md` prompt files (the extension throws at load time if any prompt
   file is missing).
4. Tell the user to launch with `just fh-workhorse` (cheap test pair) and confirm the
   ＦＵＳＩＯＮ ＨＡＲＮＥＳＳ boot banner renders. `just fh-sota` is the frontier
   pair and costs real money.
5. Report what was installed, what was already present, and anything still blocking.
