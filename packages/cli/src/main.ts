#!/usr/bin/env node

const entrypoints = new Map([
  ["init", "./init.js"],
  ["deploy", "./deploy.js"],
  ["validate", "./validate.js"],
]);
const usage = "Usage: krun <init|deploy|validate> [arguments]";
const command = process.argv[2];
if (command === "--help") console.log(usage);
else {
  const entrypoint = entrypoints.get(command ?? "");
  if (entrypoint === undefined) {
    console.error(usage);
    process.exitCode = 1;
  } else {
    process.argv.splice(2, 1);
    await import(new URL(entrypoint, import.meta.url).href);
  }
}
