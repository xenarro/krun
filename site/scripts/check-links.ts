// Checks every internal link in the built site, exactly as GitHub Pages will
// serve it under the deployment base path.
//
//   node site/scripts/check-links.ts [--dist <dir>]
//
// Standard library only; runs with plain `node` (built-in type stripping).
// Every href, src, srcset and poster in every HTML page of `dist` that points
// at this site (a relative path, a base-absolute path, or an absolute URL on
// KRUN_SITE_ORIGIN) must resolve to a built file under KRUN_SITE_BASE, and
// every #fragment must name an id on the target page. External URLs are not
// fetched. A directory link without its trailing slash only warns, because
// GitHub Pages answers it with a redirect.

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

interface LinkReport {
  readonly pages: number;
  readonly links: number;
  readonly problems: readonly string[];
  readonly warnings: readonly string[];
}

interface Page {
  readonly path: string;
  readonly ids: ReadonlySet<string>;
  readonly references: readonly string[];
}

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const placeholderOrigin = "https://krun-site.invalid";
const linkAttributes = new Set(["href", "src", "poster"]);

const normalizeBase = (value: string): string => {
  const trimmed = value.trim().replace(/^\/*/, "/").replace(/\/*$/, "/");
  if (!/^\/(?:[A-Za-z0-9._~-]+\/)*$/.test(trimmed)) {
    throw new Error(`KRUN_SITE_BASE must be a path such as /krun/, got ${JSON.stringify(value)}`);
  }
  return trimmed;
};

const entities: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

const decodeEntities = (value: string): string =>
  value.replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/gi, (match, name: string) => {
    if (name.startsWith("#x") || name.startsWith("#X")) {
      return String.fromCodePoint(Number.parseInt(name.slice(2), 16));
    }
    if (name.startsWith("#")) return String.fromCodePoint(Number.parseInt(name.slice(1), 10));
    return entities[name.toLowerCase()] ?? match;
  });

const listHtml = (directory: string): string[] =>
  readdirSync(directory, { recursive: true, encoding: "utf8" })
    .filter((name) => name.endsWith(".html"))
    .map((name) => join(directory, name))
    .sort();

/** The public URL path of a built HTML file. */
const pagePath = (dist: string, file: string, base: string): string => {
  const path = relative(dist, file).split(sep).join("/");
  if (path === "index.html") return base;
  if (path.endsWith("/index.html")) return `${base}${path.slice(0, -"index.html".length)}`;
  return `${base}${path}`;
};

const tagPattern =
  /<([a-zA-Z][^\s/>]*)((?:\s+[^\s=/>]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?)*)\s*\/?>/g;
const attributePattern = /([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;

/** Reads ids and link-bearing attributes, ignoring scripts, styles and comments. */
const parsePage = (html: string, path: string): Page => {
  const markup = html
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<(script|style|template)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, (match) =>
      match.slice(0, match.indexOf(">") + 1),
    );
  const ids = new Set<string>();
  const references: string[] = [];
  for (const tag of markup.matchAll(tagPattern)) {
    const tagName = (tag[1] ?? "").toLowerCase();
    for (const attribute of (tag[2] ?? "").matchAll(attributePattern)) {
      const name = (attribute[1] ?? "").toLowerCase();
      const raw = attribute[2] ?? attribute[3] ?? attribute[4];
      if (raw === undefined) continue;
      const value = decodeEntities(raw).trim();
      if (name === "id" || (name === "name" && tagName === "a")) ids.add(value);
      else if (linkAttributes.has(name)) references.push(value);
      else if (name === "srcset") {
        for (const candidate of value.split(",")) {
          const url = candidate.trim().split(/\s+/)[0];
          if (url) references.push(url);
        }
      } else if (name === "content" && /^https?:\/\//.test(value)) references.push(value);
    }
  }
  return { path, ids, references };
};

/** The built file for a URL path under `base`, or undefined. */
const resolveFile = (dist: string, path: string, base: string): string | undefined => {
  const inside = path.slice(base.length);
  const file = resolve(dist, ...inside.split("/").filter(Boolean));
  if (file !== dist && !file.startsWith(dist + sep)) return undefined;
  if (path.endsWith("/")) {
    const index = join(file, "index.html");
    return existsSync(index) ? index : undefined;
  }
  return existsSync(file) && statSync(file).isFile() ? file : undefined;
};

export function checkSite(options: { dist: string; base: string; origin: string }): LinkReport {
  const dist = resolve(options.dist);
  const base = normalizeBase(options.base);
  const origin = new URL(options.origin).origin;
  if (!existsSync(join(dist, "index.html"))) {
    return {
      pages: 0,
      links: 0,
      problems: [`${dist}: no index.html; build the site first`],
      warnings: [],
    };
  }
  const pages = new Map<string, Page>();
  for (const file of listHtml(dist)) {
    pages.set(file, parsePage(readFileSync(file, "utf8"), pagePath(dist, file, base)));
  }
  const problems: string[] = [];
  const warnings: string[] = [];
  let links = 0;
  for (const page of pages.values()) {
    for (const reference of page.references) {
      if (reference === "" || /^(?:mailto|tel|javascript|data|blob):/i.test(reference)) continue;
      let url: URL;
      try {
        url = new URL(reference, `${placeholderOrigin}${page.path}`);
      } catch {
        problems.push(`${page.path}: unparsable link ${JSON.stringify(reference)}`);
        continue;
      }
      if (url.origin !== placeholderOrigin && url.origin !== origin) continue;
      links += 1;
      let path: string;
      try {
        path = decodeURIComponent(url.pathname);
      } catch {
        problems.push(`${page.path}: invalid percent escape in ${JSON.stringify(reference)}`);
        continue;
      }
      if (!path.startsWith(base)) {
        problems.push(`${page.path}: ${JSON.stringify(reference)} leaves the base path ${base}`);
        continue;
      }
      let file = resolveFile(dist, path, base);
      if (!file && !path.endsWith("/") && resolveFile(dist, `${path}/`, base)) {
        warnings.push(`${page.path}: ${JSON.stringify(reference)} redirects; add a trailing slash`);
        file = resolveFile(dist, `${path}/`, base);
      }
      if (!file) {
        problems.push(`${page.path}: ${JSON.stringify(reference)} is not a built file`);
        continue;
      }
      const fragment = url.hash.slice(1);
      if (fragment === "") continue;
      const target = pages.get(file);
      if (!target) continue;
      let id: string;
      try {
        id = decodeURIComponent(fragment);
      } catch {
        id = fragment;
      }
      if (!target.ids.has(id)) {
        problems.push(`${page.path}: ${JSON.stringify(reference)} has no #${id} on ${target.path}`);
      }
    }
  }
  return { pages: pages.size, links, problems, warnings };
}

const main = (argv: readonly string[]): number => {
  let dist = join(scriptDirectory, "..", "dist");
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const value = argv[index + 1];
    if (argument === "--dist" && value) {
      dist = resolve(value);
      index += 1;
    } else {
      process.stderr.write("Usage: node site/scripts/check-links.ts [--dist <dir>]\n");
      return 2;
    }
  }
  const report = checkSite({
    dist,
    base: process.env.KRUN_SITE_BASE ?? "/krun/",
    origin: process.env.KRUN_SITE_ORIGIN || "https://xenarro.github.io",
  });
  for (const warning of report.warnings) process.stderr.write(`warning: ${warning}\n`);
  for (const problem of report.problems) process.stderr.write(`broken: ${problem}\n`);
  process.stdout.write(
    `Checked ${report.links} internal links on ${report.pages} pages: ${report.problems.length} broken, ${report.warnings.length} warnings.\n`,
  );
  return report.problems.length === 0 ? 0 : 1;
};

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = main(process.argv.slice(2));
}
