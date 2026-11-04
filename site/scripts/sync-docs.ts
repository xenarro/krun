// Mirrors the canonical long-form repository documents into the Starlight
// content tree, so the site never carries a hand-edited copy of them.
//
//   node site/scripts/sync-docs.ts           write src/content/docs/reference/generated/
//   node site/scripts/sync-docs.ts --check   fail when the written output is stale
//
// Standard library only; runs with plain `node` (built-in type stripping).
// The output depends only on the source files and the table below. Every
// source must exist, and every relative link must resolve inside the
// repository. Relative links to another mirrored file become site routes
// under the authoring base /krun/ (astro.config.mjs moves /krun/ links when the
// site is built for another base, so the output never depends on the
// environment); every other repository link becomes a GitHub URL on the
// default branch. Links inside fenced code blocks and code
// spans are never touched. Indented (four-space) code blocks are treated as
// prose, so keep repository links out of them in mirrored documents.

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, posix, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

interface Mirror {
  /** Repository-relative POSIX path of the canonical document. */
  readonly source: string;
  /** Output file name (without extension) and route segment. */
  readonly slug: string;
  readonly title: string;
  readonly description: string;
  readonly order: number;
}

const repositoryUrl = "https://github.com/xenarro/krun";
const branch = "main";
const outputSubdirectory = "reference/generated";

const mirrors: readonly Mirror[] = [
  {
    source: "docs/API.md",
    slug: "public-api",
    title: "Public API contract (v1)",
    description:
      "The normative /v1 HTTP contract: resources, methods, views, errors, idempotency, webhooks and examples.",
    order: 10,
  },
  {
    source: "docs/INTERNAL-API.md",
    slug: "internal-api",
    title: "Internal API contract (v1)",
    description:
      "The per-run, token-scoped /internal/v1 contract between a function container and the gateway.",
    order: 11,
  },
  {
    source: "docs/OPERATIONS.md",
    slug: "operations",
    title: "Operations guide",
    description:
      "Install, upgrade, capacity, alerts, backup and restore, telemetry and security operations for the platform team.",
    order: 12,
  },
  {
    source: "deploy/helm/krun/README.md",
    slug: "helm-chart",
    title: "Helm chart reference",
    description:
      "The generated reference for the krun Helm chart: prerequisites, install from source, lifecycle and every value.",
    order: 13,
  },
  {
    source: "sdk/node/README.md",
    slug: "node-sdk",
    title: "Node.js SDK reference",
    description: "Reference for @krun/sdk, the dependency-free Node.js 22+ function runtime.",
    order: 14,
  },
  {
    source: "sdk/python/README.md",
    slug: "python-sdk",
    title: "Python SDK reference",
    description: "Reference for the dependency-free Python 3.11+ krun function SDK.",
    order: 15,
  },
  {
    source: "docs/RELEASE.md",
    slug: "release",
    title: "Release preparation",
    description:
      "The credential-free release rehearsal, packaging decisions and the owner boundary before any publication.",
    order: 16,
  },
];

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const siteRoot = resolve(scriptDirectory, "..");
const repositoryRoot = resolve(siteRoot, "..");
const outputDirectory = join(siteRoot, "src", "content", "docs", ...outputSubdirectory.split("/"));

class SyncError extends Error {}

/** Site links are authored for https://xenarro.github.io/krun/; see base-links.ts. */
const authoringBase = "/krun/";
const routes = new Map(
  mirrors.map((mirror) => [mirror.source, `${authoringBase}${outputSubdirectory}/${mirror.slug}/`]),
);

/** Rewrites one link destination found in `source`; returns it unchanged when it is not a repository path. */
const rewriteDestination = (destination: string, source: string, errors: string[]): string => {
  const bracketed = destination.startsWith("<") && destination.endsWith(">");
  const raw = bracketed ? destination.slice(1, -1) : destination;
  if (
    raw === "" ||
    raw.startsWith("#") ||
    raw.startsWith("//") ||
    /^[A-Za-z][A-Za-z0-9+.-]*:/.test(raw)
  )
    return destination;
  const hashIndex = raw.indexOf("#");
  const beforeHash = hashIndex === -1 ? raw : raw.slice(0, hashIndex);
  const fragment = hashIndex === -1 ? "" : raw.slice(hashIndex);
  const queryIndex = beforeHash.indexOf("?");
  const pathPart = queryIndex === -1 ? beforeHash : beforeHash.slice(0, queryIndex);
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathPart);
  } catch {
    errors.push(`${source}: link ${JSON.stringify(raw)} has an invalid percent escape`);
    return destination;
  }
  const joined = decoded.startsWith("/")
    ? posix.normalize(decoded.slice(1))
    : posix.normalize(posix.join(posix.dirname(source), decoded));
  const target = joined.replace(/\/+$/, "");
  if (target === ".." || target.startsWith("../") || target === "" || target === ".") {
    errors.push(`${source}: link ${JSON.stringify(raw)} leaves the repository`);
    return destination;
  }
  const route = routes.get(target);
  let rewritten: string;
  if (route !== undefined) rewritten = `${route}${fragment}`;
  else {
    const absolute = join(repositoryRoot, ...target.split("/"));
    if (!existsSync(absolute)) {
      errors.push(`${source}: link ${JSON.stringify(raw)} points at missing ${target}`);
      return destination;
    }
    const kind = statSync(absolute).isDirectory() ? "tree" : "blob";
    const encoded = target.split("/").map(encodeURIComponent).join("/");
    rewritten = `${repositoryUrl}/${kind}/${branch}/${encoded}${fragment}`;
  }
  return bracketed ? `<${rewritten}>` : rewritten;
};

/** Splits prose into code-span and text pieces using CommonMark backtick-run matching. */
const splitCodeSpans = (text: string): { readonly code: boolean; readonly value: string }[] => {
  const pieces: { code: boolean; value: string }[] = [];
  let cursor = 0;
  let textStart = 0;
  while (cursor < text.length) {
    if (text[cursor] !== "`") {
      cursor++;
      continue;
    }
    let runEnd = cursor;
    while (text[runEnd] === "`") runEnd++;
    const run = text.slice(cursor, runEnd);
    let search = runEnd;
    let closing = -1;
    while (search < text.length) {
      const found = text.indexOf(run, search);
      if (found === -1) break;
      let after = found + run.length;
      if (text[found - 1] !== "`" && text[after] !== "`") {
        closing = found;
        break;
      }
      while (text[after] === "`") after++;
      search = after;
    }
    if (closing === -1) {
      cursor = runEnd;
      continue;
    }
    if (cursor > textStart) pieces.push({ code: false, value: text.slice(textStart, cursor) });
    pieces.push({ code: true, value: text.slice(cursor, closing + run.length) });
    cursor = closing + run.length;
    textStart = cursor;
  }
  if (textStart < text.length) pieces.push({ code: false, value: text.slice(textStart) });
  return pieces;
};

const inlineLink = /\]\(\s*(<[^>\n]*>|[^\s()<>]+)/g;
const referenceDefinition = /^( {0,3}\[[^\]\n]+\]:[ \t]*)(<[^>\n]*>|\S+)/gm;

const rewriteProse = (text: string, source: string, errors: string[]): string =>
  splitCodeSpans(text)
    .map((piece) =>
      piece.code
        ? piece.value
        : piece.value
            .replace(inlineLink, (match: string, destination: string) => {
              const rewritten = rewriteDestination(destination, source, errors);
              return match.replace(destination, () => rewritten);
            })
            .replace(
              referenceDefinition,
              (_match: string, prefix: string, destination: string) =>
                `${prefix}${rewriteDestination(destination, source, errors)}`,
            ),
    )
    .join("");

const fenceOpen = /^ {0,3}(`{3,}|~{3,})/;

/** Rewrites links in prose segments, leaving fenced code blocks byte-for-byte unchanged. */
const rewriteLinks = (markdown: string, source: string, errors: string[]): string => {
  const lines = markdown.split("\n");
  const output: string[] = [];
  let prose: string[] = [];
  let fence: string | undefined;
  const flush = () => {
    if (prose.length > 0) output.push(rewriteProse(prose.join("\n"), source, errors));
    prose = [];
  };
  for (const line of lines) {
    if (fence === undefined) {
      const opening = fenceOpen.exec(line);
      const marker = opening?.[1];
      if (
        marker !== undefined &&
        !(marker.startsWith("`") && line.slice(line.indexOf(marker) + marker.length).includes("`"))
      ) {
        flush();
        fence = marker;
        output.push(line);
      } else prose.push(line);
    } else {
      output.push(line);
      const closing = new RegExp(
        `^ {0,3}${fence[0] === "`" ? "`" : "~"}{${fence.length},}[ \\t]*$`,
      );
      if (closing.test(line)) fence = undefined;
    }
  }
  if (fence !== undefined) errors.push(`${source}: unterminated code fence`);
  flush();
  return output.join("\n");
};

/** Removes the document's leading ATX H1; Starlight renders the frontmatter title instead. */
const stripLeadingTitle = (markdown: string, source: string, errors: string[]): string => {
  const lines = markdown.split("\n");
  let index = 0;
  while (index < lines.length && lines[index]?.trim() === "") index++;
  const heading = lines[index];
  if (heading === undefined || !/^# \S/.test(heading)) {
    errors.push(`${source}: expected a leading "# " title to replace with frontmatter`);
    return markdown;
  }
  index++;
  while (index < lines.length && lines[index]?.trim() === "") index++;
  return lines.slice(index).join("\n");
};

const yamlString = (value: string): string => JSON.stringify(value);

const render = (mirror: Mirror, errors: string[]): string => {
  const sourcePath = join(repositoryRoot, ...mirror.source.split("/"));
  const original = readFileSync(sourcePath, "utf8").replace(/\r\n?/g, "\n");
  const body = rewriteLinks(
    stripLeadingTitle(original, mirror.source, errors),
    mirror.source,
    errors,
  ).replace(/\s+$/, "");
  const blobUrl = `${repositoryUrl}/blob/${branch}/${mirror.source}`;
  return [
    "---",
    `title: ${yamlString(mirror.title)}`,
    `description: ${yamlString(mirror.description)}`,
    `editUrl: ${yamlString(`${repositoryUrl}/edit/${branch}/${mirror.source}`)}`,
    "sidebar:",
    `  order: ${mirror.order}`,
    "---",
    "",
    `<!-- Generated by site/scripts/sync-docs.ts from ${mirror.source}. Do not edit; edit the source. -->`,
    "",
    ":::note[Mirrored document]",
    `This page mirrors [\`${mirror.source}\`](${blobUrl}) on the \`${branch}\` branch.`,
    "Edit the source file; this copy is regenerated by `site/scripts/sync-docs.ts`.",
    ":::",
    "",
    body,
    "",
  ].join("\n");
};

const main = (argv: readonly string[]): number => {
  const unknown = argv.filter((argument) => argument !== "--check");
  if (unknown.length > 0 || argv.length > 1) {
    process.stderr.write("Usage: node site/scripts/sync-docs.ts [--check]\n");
    return 2;
  }
  const check = argv.includes("--check");
  const missing = mirrors
    .map((mirror) => mirror.source)
    .filter((source) => {
      const absolute = join(repositoryRoot, ...source.split("/"));
      return !existsSync(absolute) || !statSync(absolute).isFile();
    });
  if (missing.length > 0) {
    process.stderr.write(`sync-docs: missing source file(s): ${missing.join(", ")}\n`);
    return 1;
  }
  const slugs = new Set(mirrors.map((mirror) => mirror.slug));
  if (slugs.size !== mirrors.length) throw new SyncError("duplicate slug in the mirror table");

  const errors: string[] = [];
  const expected = new Map(mirrors.map((mirror) => [`${mirror.slug}.md`, render(mirror, errors)]));
  if (errors.length > 0) {
    process.stderr.write(
      `sync-docs: ${errors.length} problem(s):\n${errors.map((error) => `  ${error}\n`).join("")}`,
    );
    return 1;
  }

  const present = existsSync(outputDirectory)
    ? readdirSync(outputDirectory)
        .filter((name) => /\.mdx?$/.test(name))
        .sort()
    : [];
  const stale = present.filter((name) => !expected.has(name));
  const changed = [...expected].filter(([name, content]) => {
    const path = join(outputDirectory, name);
    return !existsSync(path) || readFileSync(path, "utf8") !== content;
  });

  if (check) {
    if (changed.length === 0 && stale.length === 0) {
      process.stdout.write(`sync-docs: ${expected.size} mirrored page(s) are current\n`);
      return 0;
    }
    for (const [name] of changed) process.stderr.write(`sync-docs: out of date: ${name}\n`);
    for (const name of stale) process.stderr.write(`sync-docs: unexpected file: ${name}\n`);
    process.stderr.write("sync-docs: run node site/scripts/sync-docs.ts\n");
    return 1;
  }

  mkdirSync(outputDirectory, { recursive: true });
  for (const [name, content] of changed)
    writeFileSync(join(outputDirectory, name), content, "utf8");
  for (const name of stale) unlinkSync(join(outputDirectory, name));
  process.stdout.write(
    `sync-docs: ${expected.size} mirrored page(s); ${changed.length} written, ${stale.length} removed\n`,
  );
  return 0;
};

try {
  process.exitCode = main(process.argv.slice(2));
} catch (error) {
  process.stderr.write(`sync-docs: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
