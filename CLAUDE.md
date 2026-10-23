# krun agent rules

1. Read SPEC.md fully, then docs/API.md and docs/INTERNAL-API.md, then docs/STACK.md, then PLAN.md, then docs/OPERATIONS.md, before any change. docs/PROBLEM.md says why krun exists; docs/AGENT-KICKOFF.md holds the session prompts.
2. Follow the agent protocol in PLAN.md section 1.
3. Run `make check` before every commit.
4. Never build anything SPEC.md section 1 lists as a non-goal.
5. Never add a `Co-Authored-By` trailer or any Claude attribution to commits or pull requests.
6. krun is TypeScript on Node.js 26: Effect 4 as the foundation, Fastify 5 for HTTP, Zod 4 for every schema (SPEC D35, docs/STACK.md). SDKs are TypeScript and Python without runtime dependencies. No other language, runtime or library outside docs/STACK.md.
7. Before coding a task, load the skills docs/STACK.md section 5 lists for its area. Effect's MIGRATION.md overrides skill text written for Effect 3.
8. Never call `Date.now()` or `new Date()` in application code; use Effect `Clock` and `DateTime`.
9. Name task branches `<type>/<short-kebab-case-description>`, using `feat/`, `fix/`, `docs/`, `refactor/`, `test/`, `chore/`, `build/`, `ci/`, or `perf/` to match the work (for example, `feat/admin-health-telemetry`). Do not create bare task-ID branches such as `p0-7-implementation`. These rules override branch-name suggestions in generated agent prompts; do not rename shared or published branches without coordinating their PRs and other workers.
10. Always use Conventional Commits: `<type>(<optional-scope>): <short-imperative-description>` (for example, `feat(telemetry): add admin metrics endpoint` or `docs(agents): define branch naming rules`). Use `!` and a `BREAKING CHANGE:` footer for breaking changes. Apply this convention to every commit, PR title, and squash-merge commit message.
