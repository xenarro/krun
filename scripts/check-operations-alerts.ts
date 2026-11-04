import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseAllDocuments } from "yaml";
import { z } from "zod";

const ruleSchema = z.object({
  kind: z.literal("PrometheusRule"),
  spec: z.object({
    groups: z
      .array(z.object({ rules: z.array(z.object({ alert: z.string().min(1) })).min(1) }))
      .min(1),
  }),
});
export const verifyAlertNames = (markdown: string, rendered: string): string[] => {
  const sections = markdown.split(/^## Alerts and first checks\s*$/m);
  if (sections.length !== 2) throw new Error("Missing or ambiguous operations alert section");
  const section = (sections[1] ?? "").split(/^## /m)[0] ?? "";
  const rows = section
    .split("\n")
    .map((line) => line.replace(/^ {1,3}(?=\|)/, ""))
    .filter((line) => line.startsWith("|"));
  if (
    rows.length < 3 ||
    rows[0] !== "| Rule | Meaning | First checks |" ||
    rows[1] !== "|---|---|---|"
  )
    throw new Error("Invalid operations alert table");
  const names = rows.slice(2).map((row) => {
    const match = /^\| `([A-Za-z][A-Za-z0-9_]*)` \|.+\|$/.exec(row);
    if (!match?.[1]) throw new Error("Invalid documented alert name");
    return match[1];
  });
  const documents = parseAllDocuments(rendered);
  if (documents.some((doc) => doc.errors.length)) throw new Error("Invalid rendered YAML");
  const rules = documents
    .map((doc) => doc.toJSON() as unknown)
    .filter((value) => z.object({ kind: z.literal("PrometheusRule") }).safeParse(value).success);
  if (rules.length !== 1) throw new Error("Missing or ambiguous rendered PrometheusRule");
  const alerts = ruleSchema
    .parse(rules[0])
    .spec.groups.flatMap((group) => group.rules.map((rule) => rule.alert));
  if (
    new Set(names).size !== names.length ||
    new Set(alerts).size !== alerts.length ||
    JSON.stringify([...names].sort()) !== JSON.stringify([...alerts].sort())
  )
    throw new Error("Operations alert names do not match rendered rules");
  return [...names].sort();
};

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const root = fileURLToPath(new URL("../", import.meta.url));
    const markdown = readFileSync(`${root}docs/OPERATIONS.md`, "utf8");
    let names: string[] = [];
    for (const mode of ["embedded", "postgres"]) {
      const rendered = spawnSync(
        "helm",
        [
          "template",
          "krun-test-operations",
          `${root}deploy/helm/krun`,
          "--set-json",
          JSON.stringify({
            db: { mode, postgres: { existingSecret: "krun-test-unused" } },
            gateway: { replicas: 1 },
            apiKeys: { existingSecret: "krun-test-unused" },
            metrics: { prometheusRule: { enabled: true } },
          }),
        ],
        { encoding: "utf8", timeout: 30_000, maxBuffer: 8 * 1024 * 1024 },
      );
      if (rendered.error || rendered.status !== 0)
        throw new Error("Operations rule rendering failed");
      names = verifyAlertNames(markdown, rendered.stdout);
    }
    console.log(
      JSON.stringify({
        event: "operations_alert_names",
        verified: true,
        modes: ["embedded", "postgres"],
        ruleNames: names,
      }),
    );
  } catch {
    console.error("Operations alert verification failed");
    process.exitCode = 1;
  }
}
