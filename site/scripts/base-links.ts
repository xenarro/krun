/**
 * Content links are authored for the project site, under the base /krun/
 * (Markdown pages and the documents scripts/sync-docs.ts mirrors). When the
 * site is built for another base path, for example a custom domain served
 * from the root, astro.config.mjs registers this hast plugin on Astro's
 * Markdown processor (Sätteri), and it moves every such href and src to the
 * configured base so routes, anchors and assets still resolve.
 */

/** The base path that content links are written against. */
export const authoringBase = "/krun/";

/** Rewrites `value` from the authoring base to `base`, or returns it unchanged. */
export const rebase = (value: string, base: string): string =>
  value.startsWith(authoringBase) ? `${base}${value.slice(authoringBase.length)}` : value;

/** The part of a Sätteri hast element this plugin reads. */
interface Element {
  readonly properties?: Readonly<Record<string, unknown>>;
}

/** The part of Sätteri's visitor context this plugin uses. */
interface VisitContext {
  setProperty(node: Element, key: string, value: unknown): void;
}

/** A Sätteri hast plugin that moves `/krun/...` links and images to `base`. */
export function baseLinksPlugin(base: string) {
  return {
    name: "krun-base-links",
    element: [
      {
        filter: ["a", "img"],
        visit(node: Element, context: VisitContext): void {
          for (const key of ["href", "src"]) {
            const value = node.properties?.[key];
            if (typeof value === "string" && value.startsWith(authoringBase))
              context.setProperty(node, key, rebase(value, base));
          }
        },
      },
    ],
  };
}
