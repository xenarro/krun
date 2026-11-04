import { getCollection } from "astro:content";

export const repository = "https://github.com/xenarro/krun";
export const blob = (path: string): string => `${repository}/blob/main/${path}`;

/** A site path under the deployed base, for example `withBase("start/")`. */
export const withBase = (path: string): string =>
  `${import.meta.env.BASE_URL.replace(/\/?$/, "/")}${path.replace(/^\/+/, "")}`;

type Docs = Awaited<ReturnType<typeof getCollection<"docs">>>;
let docs: Promise<Docs> | undefined;
const allDocs = (): Promise<Docs> => {
  docs ??= getCollection("docs");
  return docs;
};

/** The route of a docs entry id such as `start/quickstart`, if that page exists. */
async function pageRoute(id: string): Promise<string | undefined> {
  const entry = (await allDocs()).find((candidate) => candidate.id === id);
  return entry ? withBase(`${entry.id}/`) : undefined;
}

/** The first page of a sidebar section, by `sidebar.order` and then id. */
export async function firstPageIn(directory: string): Promise<string | undefined> {
  const entries = (await allDocs())
    .filter((entry) => entry.id.startsWith(`${directory}/`))
    .sort(
      (a, b) =>
        (a.data.sidebar?.order ?? Number.MAX_SAFE_INTEGER) -
          (b.data.sidebar?.order ?? Number.MAX_SAFE_INTEGER) || a.id.localeCompare(b.id),
    );
  const first = entries[0];
  return first ? withBase(`${first.id}/`) : undefined;
}

/** "Get started", "Documentation" and "GitHub" targets shared by the hero, 404 and footer. */
export async function primaryLinks(): Promise<{ start: string; docs: string; github: string }> {
  const docsHome = (await firstPageIn("start")) ?? withBase("");
  const start = (await pageRoute("start/quickstart")) ?? docsHome;
  return { start, docs: docsHome, github: repository };
}
