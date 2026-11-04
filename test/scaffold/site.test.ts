import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { authoringBase, baseLinksPlugin, rebase } from "../../site/scripts/base-links.ts";
import { checkSite } from "../../site/scripts/check-links.ts";

const root = new URL("../../", import.meta.url);
const read = (path: string) => readFileSync(new URL(path, root), "utf8");

const page = (body: string, head = "") =>
  `<!doctype html><html><head>${head}</head><body>${body}</body></html>`;

function fixture(files: Record<string, string>) {
  const directory = mkdtempSync(join(tmpdir(), "krun-site-links-"));
  for (const [name, content] of Object.entries(files)) {
    mkdirSync(dirname(join(directory, name)), { recursive: true });
    writeFileSync(join(directory, name), content);
  }
  return directory;
}

describe("site link checker", () => {
  const options = { base: "/krun/", origin: "https://xenarro.github.io" };

  it("accepts base-absolute, relative, absolute same-origin and anchor links", () => {
    const dist = fixture({
      "index.html": page(
        '<a href="/krun/guide/">guide</a><a href="guide/#setup">setup</a><a href="#top" id="top">top</a><img src="/krun/logo.svg" srcset="/krun/logo.svg 1x, logo.svg 2x"><a href="https://example.com/x">x</a><a href="mailto:a@b.c">m</a>',
        '<link rel="canonical" href="https://xenarro.github.io/krun/"><meta property="og:image" content="https://xenarro.github.io/krun/logo.svg"><script>const x = "<a href=\\"/krun/missing/\\">";</script>',
      ),
      "guide/index.html": page('<h2 id="setup">Setup</h2><a href="../">home</a>'),
      "logo.svg": "<svg/>",
    });
    try {
      const report = checkSite({ dist, ...options });
      expect(report.problems).toEqual([]);
      expect(report.warnings).toEqual([]);
      expect(report.pages).toBe(2);
      expect(report.links).toBeGreaterThanOrEqual(8);
    } finally {
      rmSync(dist, { recursive: true, force: true });
    }
  });

  it("reports missing files, missing anchors, links outside the base and broken canonicals", () => {
    const dist = fixture({
      "index.html": page(
        '<a href="/krun/nope/">a</a><img src="/krun/missing.png"><a href="/krun/guide/#absent">b</a><a href="/other/">c</a>',
        '<link rel="canonical" href="https://xenarro.github.io/krun/gone/">',
      ),
      "guide/index.html": page('<h2 id="present">Present</h2><a href="/krun/guide">no slash</a>'),
    });
    try {
      const report = checkSite({ dist, ...options });
      const problems = report.problems.join("\n");
      expect(report.problems).toHaveLength(5);
      expect(problems).toContain('"/krun/nope/" is not a built file');
      expect(problems).toContain('"/krun/missing.png" is not a built file');
      expect(problems).toContain("has no #absent on /krun/guide/");
      expect(problems).toContain('"/other/" leaves the base path /krun/');
      expect(problems).toContain('"https://xenarro.github.io/krun/gone/" is not a built file');
      expect(report.warnings).toEqual([
        '/krun/guide/: "/krun/guide" redirects; add a trailing slash',
      ]);
    } finally {
      rmSync(dist, { recursive: true, force: true });
    }
  });

  it("fails when the site has not been built", () => {
    const dist = fixture({});
    try {
      expect(checkSite({ dist, ...options }).problems[0]).toContain("no index.html");
    } finally {
      rmSync(dist, { recursive: true, force: true });
    }
  });
});

describe("site base path", () => {
  const visit = (base: string, properties: Record<string, unknown>) => {
    const changed: Record<string, unknown> = {};
    const [visitor] = baseLinksPlugin(base).element;
    visitor?.visit({ properties }, { setProperty: (_node, key, value) => (changed[key] = value) });
    return changed;
  };

  it("moves links authored under /krun/ to a root, custom-domain or nested base", () => {
    expect(baseLinksPlugin("/").element[0]?.filter).toEqual(["a", "img"]);
    expect(visit("/", { href: "/krun/guides/cli/#ship-it" })).toEqual({
      href: "/guides/cli/#ship-it",
    });
    expect(visit("/", { src: "/krun/og-image.png" })).toEqual({ src: "/og-image.png" });
    expect(visit("/docs/krun/", { href: "/krun/start/" })).toEqual({ href: "/docs/krun/start/" });
    expect(rebase("/krun/", "/")).toBe("/");
  });

  it("leaves other links alone", () => {
    expect(visit("/", { href: "https://github.com/xenarro/krun/" })).toEqual({});
    expect(visit("/", { href: "/krunner/" })).toEqual({});
    expect(visit("/", { href: "#top" })).toEqual({});
    expect(rebase("/krun/x/", authoringBase)).toBe("/krun/x/");
  });
});

describe("site package and Pages workflow", () => {
  it("keeps the site out of recursive build, lint and production dependency checks", () => {
    const manifest = JSON.parse(read("site/package.json"));
    expect(manifest.private).toBe(true);
    for (const script of ["build", "lint", "test"])
      expect(manifest.scripts[script]).toBeUndefined();
    expect(manifest.scripts["site:build"]).toBe("node scripts/sync-docs.ts && astro build");
    expect(manifest.dependencies).toBeUndefined();
    expect(Object.keys(manifest.devDependencies)).toEqual(
      expect.arrayContaining(["astro", "@astrojs/starlight"]),
    );
    expect(read("site/vitest.config.ts")).toContain("passWithNoTests: true");
    expect(read("pnpm-workspace.yaml")).toContain("  - site\n");
    expect(read(".gitignore")).toContain("site/src/content/docs/reference/generated/");
  });

  it("builds on pull requests and deploys only main with SHA-pinned, least-privilege actions", () => {
    const text = read(".github/workflows/pages.yml");
    const workflow = parse(text);
    expect(text).not.toContain("pull_request_target");
    expect(text).not.toMatch(/run:.*\$\{\{/);
    expect(text).not.toContain("continue-on-error");
    expect(workflow.permissions).toEqual({ contents: "read" });
    expect(workflow.on.push.branches).toEqual(["main"]);
    expect(workflow.on.pull_request.paths).toEqual(expect.arrayContaining(["site/**", "docs/**"]));
    for (const match of text.matchAll(/uses:\s*(\S+)(.*)/g)) {
      expect(match[1]).toMatch(/^[\w.-]+\/[\w./-]+@[a-f0-9]{40}$/);
      expect(match[2]).toMatch(/^ # v\d+\.\d+\.\d+$/);
    }
    const { build, deploy } = workflow.jobs;
    expect(build.permissions).toEqual({ contents: "read", pages: "read" });
    expect(build.steps[0].with["persist-credentials"]).toBe(false);
    const runs = build.steps.map((step: { run?: string }) => step.run ?? "").join("\n");
    expect(runs).toContain("pnpm install --frozen-lockfile");
    expect(runs).toContain("pnpm run site:build");
    expect(runs).toContain("site:links");
    const upload = build.steps.find((step: { uses?: string }) =>
      step.uses?.startsWith("actions/upload-pages-artifact@"),
    );
    expect(upload.if).toContain("refs/heads/main");
    expect(upload.with.path).toBe("site/dist");
    expect(deploy.if).toContain("refs/heads/main");
    expect(deploy.permissions).toEqual({ pages: "write", "id-token": "write" });
    expect(deploy.environment.name).toBe("github-pages");
  });
});
