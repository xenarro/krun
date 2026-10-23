# krun agent rules

1. Read SPEC.md fully, then docs/API.md and docs/INTERNAL-API.md, then docs/STACK.md, then PLAN.md, then docs/OPERATIONS.md, before any change. docs/PROBLEM.md says why krun exists; docs/AGENT-KICKOFF.md holds the session prompts.
2. Follow the agent protocol in PLAN.md section 1.
3. Run `make check` before every commit.
4. Never build anything SPEC.md section 1 lists as a non-goal.
5. Never add a `Co-Authored-By` trailer or any Claude attribution to commits or pull requests.
6. krun is TypeScript on Node.js 26: Effect 4 as the foundation, Fastify 5 for HTTP, Zod 4 for every schema (SPEC D35, docs/STACK.md). SDKs are TypeScript and Python without runtime dependencies. No other language, runtime or library outside docs/STACK.md.
7. Before coding a task, load the skills docs/STACK.md section 5 lists for its area. Effect's MIGRATION.md overrides skill text written for Effect 3.
8. Never call `Date.now()` or `new Date()` in application code; use Effect `Clock` and `DateTime`.
