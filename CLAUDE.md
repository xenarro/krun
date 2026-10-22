# krun agent rules

1. Read SPEC.md fully, then PLAN.md, then docs/OPERATIONS.md, before any change. docs/PROBLEM.md says why krun exists; docs/AGENT-KICKOFF.md holds the session prompts.
2. Follow the agent protocol in PLAN.md section 1.
3. Run `make check` before every commit.
4. Never build anything SPEC.md section 1 lists as a non-goal.
5. Never add a `Co-Authored-By` trailer or any Claude attribution to commits or pull requests.
6. krun is TypeScript on Node.js 24 with Fastify (SPEC D15). SDKs are TypeScript and Python. No other language or runtime for krun itself.
