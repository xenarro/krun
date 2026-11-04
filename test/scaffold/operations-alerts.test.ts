import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { stringify } from "yaml";
import { verifyAlertNames } from "../../scripts/check-operations-alerts.js";

const markdown =
  "## Alerts and first checks\n\n| Rule | Meaning | First checks |\n|---|---|---|\n| `KrunOne` | one | check |\n| `KrunTwo2` | two | check |\n\n## Next\n";
const rendered = (names = ["KrunOne", "KrunTwo2"]) =>
  stringify({
    apiVersion: "monitoring.coreos.com/v1",
    kind: "PrometheusRule",
    spec: { groups: [{ name: "krun", rules: names.map((alert) => ({ alert, expr: "up == 0" })) }] },
  });
it("compares the entire actual alert table with rendered names, including digits", () => {
  expect(verifyAlertNames(markdown, rendered())).toEqual(["KrunOne", "KrunTwo2"]);
});
it.each([
  [markdown.replace("KrunOne", "KrunMissing"), rendered()],
  [markdown, rendered(["KrunOne"])],
  [markdown, rendered(["KrunOne", "KrunTwo2", "KrunUndocumented"])],
  [markdown.replace("KrunTwo2", "KrunOne"), rendered()],
  [markdown, rendered(["KrunOne", "KrunTwo2", "KrunOne"])],
  [markdown.replace("`KrunOne`", "KrunOne"), rendered()],
  [markdown.replace("## Alerts and first checks", "## Unrelated"), rendered()],
  ["## Alerts and first checks\n\n## Next\n", rendered()],
  [markdown, "kind: [broken"],
  [markdown, "kind: ConfigMap\n"],
  [markdown, `${rendered()}---\n${rendered()}`],
])("rejects missing, duplicate, malformed, vacuous or ambiguous rule evidence", (text, yaml) => {
  expect(() => verifyAlertNames(text, yaml)).toThrow();
});
it.each([1, 2, 3])("accepts valid table rows with %i spaces of Markdown indentation", (width) => {
  const indent = " ".repeat(width);
  expect(
    verifyAlertNames(markdown.replace("| `KrunOne`", `${indent}| \`KrunOne\``), rendered()),
  ).toEqual(["KrunOne", "KrunTwo2"]);
});
it.each([1, 2, 3])("rejects unrendered visible table rows indented %i spaces", (width) => {
  const text = markdown.replace(
    "\n## Next",
    `\n${" ".repeat(width)}| \`KrunUnrendered\` | missing | check |\n## Next`,
  );
  expect(() => verifyAlertNames(text, rendered())).toThrow();
});
it.each([1, 2, 3])("rejects duplicate visible table rows indented %i spaces", (width) => {
  const text = markdown.replace(
    "\n## Next",
    `\n${" ".repeat(width)}| \`KrunOne\` | duplicate | check |\n## Next`,
  );
  expect(() => verifyAlertNames(text, rendered())).toThrow();
});
it("runs the script against both real Helm modes and the current runbook", () => {
  const root = fileURLToPath(new URL("../../", import.meta.url));
  const result = spawnSync(process.execPath, ["scripts/check-operations-alerts.ts"], {
    cwd: root,
    encoding: "utf8",
    timeout: 10_000,
  });
  expect(result.status, result.stderr).toBe(0);
  const report = JSON.parse(result.stdout);
  expect(report.modes).toEqual(["embedded", "postgres"]);
  expect(report.ruleNames).toHaveLength(7);
  expect(report.verified).toBe(true);
});
