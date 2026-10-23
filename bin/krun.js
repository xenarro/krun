#!/usr/bin/env node

const entrypoints = new Map([
  ["gateway", "../apps/gateway/dist/main.js"],
  ["scheduler", "../apps/scheduler/dist/main.js"],
  ["migrate", "../packages/shared/dist/store/migrate.js"],
  ["validate", "../packages/cli/dist/validate.js"],
]);
const usage = "Usage: krun <gateway|scheduler|migrate|validate> [arguments]";
const command = process.argv[2];

if (command === "--help") {
  console.log(usage);
} else {
  const entrypoint = entrypoints.get(command);
  if (entrypoint === undefined) {
    console.error(usage);
    process.exitCode = 1;
  } else {
    process.argv.splice(2, 1);
    await import(new URL(entrypoint, import.meta.url).href);
  }
}
