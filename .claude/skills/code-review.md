---
name: code-review
description: Review code changes using the code-reviewer subagent. Defaults to uncommitted changes, or review a specific file/pattern if provided as an argument.
---

# Code Review

Spawn the `code-reviewer` subagent to review recent code changes.

## Arguments

The user may provide optional arguments after `/code-review`:

- **(no args)** — review all uncommitted changes (`git diff` + `git diff --staged`).
- **`<file-or-pattern>`** — review a specific file or glob (e.g. `src/extract_invoices.ts`, `src/*.ts`).

Pass the argument verbatim after the colon in the prompt below.

## Workflow

1. Parse `$ARGUMENTS` to determine the target:
   - Empty → default scope: uncommitted changes (staged + unstaged).
   - Non-empty → the argument is a file path or glob.

2. Spawn exactly one `code-reviewer` subagent using the Agent tool
   (`subagent_type: code-reviewer`). The subagent is read-only — it inspects
   code and reports findings; it does not edit, build, or run anything.

3. Pass it a prompt that tells it what to review:

   - **Default scope:** "Review uncommitted changes. Use `git diff` and
     `git diff --staged` to discover what changed, then review those changes
     and the surrounding code needed to judge them."
   - **Specific target:** "Review the file(s) matching: `<arg>`. Use Read/Grep
     to inspect them and enough surrounding context to judge correctness."

4. Relay the subagent's report back to the user verbatim. Do not summarize,
   editorialize, or filter it. The subagent's output format is the contract.

## Notes

- The subagent is read-only by design. Do not ask it to run tests, build, or
  fix anything — those are out of scope.
- If `$ARGUMENTS` is empty, do not invent a target. Default to uncommitted
  changes.
- One subagent invocation per `/code-review` call. Do not chain multiple.