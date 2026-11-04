// @ts-check
import { copyFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import starlight from "@astrojs/starlight";
import { defineConfig } from "astro/config";
import { authoringBase, baseLinksPlugin } from "./scripts/base-links.ts";

// Hosting. The defaults describe the GitHub Pages project site
// https://xenarro.github.io/krun/. The Pages workflow passes the origin and
// base path that actions/configure-pages reports, so a user site or a custom
// domain moves every route, asset, search index, sitemap and canonical URL
// without editing this file. Content links are authored with the /krun/
// prefix and scripts/base-links.ts moves them to any other base;
// scripts/check-links.ts fails the build if a link still does not resolve.
const site = (process.env.KRUN_SITE_ORIGIN || "https://xenarro.github.io").replace(/\/+$/, "");
const base = normalizeBase(process.env.KRUN_SITE_BASE ?? "/krun/");
const repository = "https://github.com/xenarro/krun";
const absolute = (path) => new URL(`${base}${path}`, site).href;

const description =
  "HTTP-triggered functions executed as one-off Kubernetes Jobs. Submit JSON over HTTP; receive durable status, an inline or object-storage result, and classified failures without giving callers Kubernetes credentials.";

/** @param {string} value */
function normalizeBase(value) {
  const trimmed = value.trim().replace(/^\/*/, "/").replace(/\/*$/, "/");
  if (!/^\/(?:[A-Za-z0-9._~-]+\/)*$/.test(trimmed)) {
    throw new Error(`KRUN_SITE_BASE must be a path such as /krun/, got ${JSON.stringify(value)}`);
  }
  return trimmed;
}

/**
 * docs/assets is the single source of truth for brand files (the README uses
 * them too). Copy the files that need stable public URLs before Vite starts;
 * the copies are git-ignored. robots.txt only works at a domain root, so its
 * route exists only when the site is served from "/". Under any base other
 * than /krun/, content links move with the site (scripts/base-links.ts).
 * @returns {import("astro").AstroIntegration}
 */
function krunSite() {
  return {
    name: "krun-site",
    hooks: {
      "astro:config:setup": ({ config, injectRoute }) => {
        if (base !== authoringBase) {
          // Sätteri (Astro's Markdown processor) runs these on .md and .mdx alike.
          const plugins = config.markdown.processor?.options?.hastPlugins;
          if (!Array.isArray(plugins))
            throw new Error("Expected Astro's Sätteri Markdown processor to move /krun/ links");
          plugins.push(baseLinksPlugin(base));
        }
        const from = new URL("../docs/assets/", import.meta.url);
        const publicDir = fileURLToPath(config.publicDir);
        mkdirSync(publicDir, { recursive: true });
        for (const file of ["favicon.svg", "apple-touch-icon.png", "og-image.png"]) {
          copyFileSync(new URL(file, from), `${publicDir}/${file}`);
        }
        if (base === "/") {
          injectRoute({ pattern: "/robots.txt", entrypoint: "./src/routes/robots.txt.ts" });
        }
      },
    },
  };
}

export default defineConfig({
  site,
  base,
  trailingSlash: "always",
  build: { format: "directory" },
  integrations: [
    krunSite(),
    starlight({
      title: "krun",
      description,
      logo: {
        light: "../docs/assets/logo-light.svg",
        dark: "../docs/assets/logo-dark.svg",
        alt: "krun",
        replacesTitle: true,
      },
      favicon: "/favicon.svg",
      editLink: { baseUrl: `${repository}/edit/main/site/` },
      lastUpdated: false,
      pagination: true,
      credits: false,
      titleDelimiter: "·",
      tableOfContents: { minHeadingLevel: 2, maxHeadingLevel: 3 },
      customCss: ["./src/styles/fonts.css", "./src/styles/tokens.css", "./src/styles/theme.css"],
      components: {
        Head: "./src/components/overrides/Head.astro",
        Hero: "./src/components/overrides/Hero.astro",
        Footer: "./src/components/overrides/Footer.astro",
        SocialIcons: "./src/components/overrides/SocialIcons.astro",
      },
      routeMiddleware: "./src/route-middleware.ts",
      head: [
        { tag: "meta", attrs: { property: "og:image", content: absolute("og-image.png") } },
        { tag: "meta", attrs: { property: "og:image:width", content: "1200" } },
        { tag: "meta", attrs: { property: "og:image:height", content: "630" } },
        {
          tag: "meta",
          attrs: {
            property: "og:image:alt",
            content: "krun: HTTP in, result out. Functions as one-off Kubernetes Jobs.",
          },
        },
        { tag: "meta", attrs: { name: "twitter:image", content: absolute("og-image.png") } },
        {
          tag: "link",
          attrs: { rel: "apple-touch-icon", href: `${base}apple-touch-icon.png` },
        },
        {
          tag: "meta",
          attrs: {
            name: "theme-color",
            content: "#f7f3ea",
            media: "(prefers-color-scheme: light)",
          },
        },
        {
          tag: "meta",
          attrs: { name: "theme-color", content: "#121016", media: "(prefers-color-scheme: dark)" },
        },
      ],
      sidebar: [
        { label: "Start here", items: [{ autogenerate: { directory: "start" } }] },
        { label: "Guides", items: [{ autogenerate: { directory: "guides" } }] },
        { label: "Reference", items: [{ autogenerate: { directory: "reference" } }] },
        { label: "Project", items: [{ autogenerate: { directory: "project" } }] },
      ],
    }),
  ],
});
