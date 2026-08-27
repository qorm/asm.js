#!/usr/bin/env node
import * as fs from "fs";
import * as net from "net";
import * as path from "path";
import { compileBuildJob } from "./job.mjs";
import { defaultBuildSocket } from "./server-path.mjs";

const socketPath = process.argv[2] || defaultBuildSocket();
try { fs.rmSync(socketPath, { force: true }); } catch (_) { /* stale socket */ }
fs.mkdirSync(path.dirname(socketPath), { recursive: true });

const server = net.createServer((socket) => {
    let buffered = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
        buffered += chunk;
        let newline;
        while ((newline = buffered.indexOf("\n")) >= 0) {
            const line = buffered.slice(0, newline);
            buffered = buffered.slice(newline + 1);
            if (!line) continue;
            let request;
            try {
                request = JSON.parse(line);
                if (request.type === "shutdown") {
                    socket.end(JSON.stringify({ ok: true }) + "\n");
                    server.close();
                    return;
                }
                const started = Date.now();
                const result = compileBuildJob(request.job || {});
                socket.write(JSON.stringify({ id: request.id, ...result, compileMs: Date.now() - started }) + "\n");
            } catch (error) {
                socket.write(JSON.stringify({
                    id: request && request.id,
                    ok: false,
                    error: String(error && error.stack ? error.stack : error)
                }) + "\n");
            }
        }
    });
});

server.listen(socketPath);
server.on("close", () => {
    try { fs.rmSync(socketPath, { force: true }); } catch (_) { /* best effort */ }
});
for (const signal of ["SIGINT", "SIGTERM"]) {
    process.on(signal, () => server.close());
}
