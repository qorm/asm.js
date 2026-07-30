#!/usr/bin/env node
// Thin wrapper: delegates to the single authoritative fixture runner
// scripts/run-fixtures.mjs, passing through arguments and exit code verbatim.
//
// It deliberately carries no independent discovery or judgement semantics.
// The old implementation required a main.js next to fixture.json (so it
// silently skipped the 5 fixtures with custom entries, 380/385 discovered)
// and counted the 2 negative fixtures — which expect compile=false but
// currently compile fine — as hard PASS, hiding real product gaps. All of
// that now lives in scripts/run-fixtures.mjs: every fixture.json is
// discovered, custom entries honored, and knownFailure fixtures report
// XFAIL/XPASS honestly.
//
// Filter options are the authoritative runner's: --suite <name>,
// --fixture <text>, --verbose, -h/--help. The legacy positional substring
// filter is gone; use --fixture instead.
import { spawnSync } from "child_process";
import path from "path";
import { fileURLToPath } from "url";

const here = path.dirname(fileURLToPath(import.meta.url));
const runner = path.join(here, "..", "scripts", "run-fixtures.mjs");

const result = spawnSync(process.execPath, [runner, ...process.argv.slice(2)], {
    stdio: "inherit",
});

if (result.error) {
    console.error(`run_fixtures wrapper: ${result.error.message}`);
    process.exit(1);
}

process.exit(result.status ?? 1);
