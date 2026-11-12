# BukuWA - rules for Claude Code

## Product
AI bookkeeper for Indonesian UMKM on WhatsApp. Spec: docs/spec.md. Read it before any task.

## Non-negotiables
- Money is integer rupiah (bigint). Never floats.
- Ledger is append-only double-entry. Never UPDATE or DELETE journals; post reversals.
- Every journal must balance; enforce in code AND with a DB constraint.
- The LLM never writes to the ledger and never computes totals. Code does arithmetic; tools return numbers.
- Nothing is posted without owner confirmation (or an auto-confirm rule they enabled).
- Every business-scoped query goes through RLS; add a cross-tenant test for every new table.
- Never send NIK/NPWP to an LLM; mask first.
- User-facing text is casual Bahasa Indonesia; code, comments and logs are English.

## Workflow
- Work one milestone at a time (docs/spec.md section 9.3); write tests first for packages/ledger, packages/idn, packages/tax.
- Run `pnpm test` and `pnpm evals` before saying a task is done.
- Prompt or model changes must not drop eval field accuracy by more than 2 points.
- Keep model names, tax rates and thresholds in config, never hard-coded.

## Stack
TypeScript, pnpm workspaces, Hono, Next.js, Postgres + Drizzle, pg-boss, Anthropic SDK, WhatsApp Cloud API, Vitest.
