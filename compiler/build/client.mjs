import * as net from "net";
import { spawn } from "child_process";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { defaultBuildSocket } from "./server-path.mjs";

const here = dirname(fileURLToPath(import.meta.url));

function connect(socketPath) {
    return new Promise((resolvePromise, reject) => {
        const socket = net.createConnection(socketPath);
        socket.once("connect", () => resolvePromise(socket));
        socket.once("error", reject);
    });
}

function delay(ms) {
    return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

async function ensureServer(socketPath) {
    try {
        return await connect(socketPath);
    } catch (_) {
        const child = spawn(process.execPath, [join(here, "server.mjs"), socketPath], {
            detached: true,
            stdio: "ignore",
            env: process.env,
        });
        child.unref();
        let lastError;
        for (let i = 0; i < 100; i++) {
            await delay(10);
            try { return await connect(socketPath); } catch (error) { lastError = error; }
        }
        throw lastError || new Error("build server did not start");
    }
}

export async function requestBuild(job, options = {}) {
    const socketPath = options.socketPath || defaultBuildSocket();
    const socket = await ensureServer(socketPath);
    const id = `${process.pid}-${Date.now()}-${Math.random()}`;
    return new Promise((resolvePromise, reject) => {
        let buffered = "";
        socket.setEncoding("utf8");
        socket.on("data", (chunk) => {
            buffered += chunk;
            const newline = buffered.indexOf("\n");
            if (newline < 0) return;
            try {
                const response = JSON.parse(buffered.slice(0, newline));
                socket.end();
                if (!response.ok) reject(new Error(response.error || "build failed"));
                else resolvePromise(response);
            } catch (error) {
                socket.destroy();
                reject(error);
            }
        });
        socket.once("error", reject);
        socket.write(JSON.stringify({ type: "build", id, job }) + "\n");
    });
}
