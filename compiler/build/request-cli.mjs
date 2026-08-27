#!/usr/bin/env node
import { requestBuild } from "./client.mjs";

try {
    const encoded = process.argv[2];
    if (!encoded) throw new Error("missing build request");
    const job = JSON.parse(encoded);
    const result = await requestBuild(job);
    process.stdout.write(JSON.stringify(result));
} catch (error) {
    process.stderr.write(String(error && error.stack ? error.stack : error) + "\n");
    process.exit(1);
}
