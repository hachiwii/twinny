#!/usr/bin/env node
import { runCli } from "./cli/commands.js";
import { toErrorMessage } from "./errors.js";

try {
  await runCli(process.argv);
} catch (error) {
  console.error(toErrorMessage(error));
  process.exitCode = 1;
}
