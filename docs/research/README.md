# Research snapshots

`node-stack-facts.md` is a library research snapshot from 2026-10-22,
verified against the published packages. The krun skills in
`.claude/skills` cite it by line number (`docs/research/node-stack-facts.md:NNN`),
so the file is kept byte-for-byte as written.

It predates SPEC.md D35. Sections 2 (`@kubernetes/client-node`), 4
(Kysely) and 5 (drivers and utilities) remain valid. Sections 1 (Node type
stripping and `node --test`) and 3 (TypeBox, `@fastify/under-pressure`,
`close-with-grace`) are superseded by docs/STACK.md: krun uses Vitest,
Zod and Effect instead. The Fastify facts in section 3 about route
schemas, request ids, logging, hooks, SSE, error handlers and listeners
still describe Fastify 5.
