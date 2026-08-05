#!/usr/bin/env node

import process from "node:process";
import { compileFile } from "../../../compiler/index.js";

function printUsage() {
    console.error("Usage: mini-cli <input> -o <output> [target]");
}

function parseArgs(argv) {
    const input = argv[2];
    let output = "";
    let target = "";

    for (let i = 3; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === "-o" || arg === "--output") {
            output = argv[i + 1] || "";
            i += 1;
            continue;
        }

        if (arg === "-t" || arg === "--target") {
            target = argv[i + 1] || "";
            i += 1;
            continue;
        }
    }

    return { input, output, target };
}

const parsed = parseArgs(process.argv || []);
if (!parsed.input || !parsed.output) {
    printUsage();
    process.exit(1);
}

const compiled = compileFile(parsed.input, parsed.output, parsed.target || undefined);
if (!compiled) {
    console.error("compile failed");
    process.exit(1);
}
