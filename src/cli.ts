#!/usr/bin/env node
import { main } from "./main.js";
import { printable } from "./sanitize.js";

let done = false;
// Safety net: if every handle goes quiet before main() settles, Node would exit 0 with no output.
// That must never pass a CI gate, so treat it as a failure.
process.on("beforeExit", () => {
  if (done) return;
  done = true;
  console.error("skillmedic: stopped before finishing (something stalled). Treating this as a failure.");
  process.exitCode = 2;
});

main(process.argv.slice(2)).then(
  (code) => { done = true; process.exitCode = code; },
  (err: unknown) => {
    done = true;
    console.error(`skillmedic: ${printable(err instanceof Error ? err.message : String(err))}`);
    process.exitCode = 2;
  },
);
