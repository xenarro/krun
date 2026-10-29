import { spawnSync } from "node:child_process";
import { accessSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = new URL("../", import.meta.url);
const chart = new URL("deploy/helm/krun/", root);
// helm-docs otherwise silently uses its default template when the custom file is absent.
accessSync(new URL("Chart.yaml", chart));
accessSync(new URL("README.md.gotmpl", chart));

function render(template: string): string {
  const result = spawnSync(
    "helm-docs",
    [
      "--chart-search-root=deploy/helm/krun",
      "--values-file=values.yaml",
      `--template-files=${template}`,
      "--ignore-non-descriptions=false",
      "--log-level=warning",
      "--dry-run",
    ],
    { cwd: root, encoding: "utf8", maxBuffer: 8 * 1024 * 1024 },
  );
  // v1.14.2 can log parse/render failures as warnings but still return zero.
  if (result.error || result.status !== 0 || result.stderr || !result.stdout.trim()) {
    if (result.stderr) process.stderr.write(result.stderr);
    throw new Error("helm-docs generation failed; use the pinned tool and check chart inputs.");
  }
  return result.stdout;
}

function valuesTable(document: string): string | undefined {
  const lines = document.split("\n");
  const heading = "| Key | Type | Default | Description |";
  const start = lines.indexOf(heading);
  if (start === -1 || lines.lastIndexOf(heading) !== start) return undefined;
  let end = start;
  while (lines[end]?.startsWith("|")) end++;
  return lines.slice(start, end).join("\n");
}

// Validate against a second genuine native render, independent of the editable
// operator template (including any overridden built-in template definitions).
// Empty native templates can emit a nonblank literal backslash-n marker.
const temporary = mkdtempSync(join(tmpdir(), "krun-helm-docs-"));
try {
  const template = join(temporary, "reference.gotmpl");
  writeFileSync(
    template,
    "{{- range .Values -}}{{- if not (or .Description .AutoDescription) -}}" +
      '{{- fail (printf "Missing values.yaml description for %s" .Key) -}}' +
      '{{- end -}}{{- end -}}{{ template "chart.header" . }}\n' +
      '{{ template "chart.valuesSection" . }}',
  );
  const reference = render(template);
  const output = render("README.md.gotmpl");
  const heading = reference.split("\n").find((line) => line.startsWith("# "));
  const expected = valuesTable(reference);
  if (
    !heading ||
    !output.trimStart().startsWith(`${heading}\n`) ||
    !expected ||
    valuesTable(output) !== expected
  ) {
    throw new Error(
      "helm-docs output must contain the chart heading and exactly the complete native values table.",
    );
  }
  // Preserve legitimate escaped newlines/defaults byte-for-byte; never normalize
  // the document to hide the empty-template marker or a missing/altered value.
  writeFileSync(fileURLToPath(new URL("README.md", chart)), output);
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
