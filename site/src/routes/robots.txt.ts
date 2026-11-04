import type { APIRoute } from "astro";

// Crawlers read robots.txt only at the domain root, so astro.config.mjs
// injects this route only when the site is served from "/" (a user site or a
// custom domain). The sitemap URL follows the deployed origin.
/** @public astro.config.mjs injects this route (injectRoute) for a root base only. */
export const GET: APIRoute = ({ site }) => {
  const sitemap = new URL(
    `${import.meta.env.BASE_URL.replace(/\/?$/, "/")}sitemap-index.xml`,
    site,
  );
  return new Response(`User-agent: *\nAllow: /\n\nSitemap: ${sitemap.href}\n`, {
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
};
