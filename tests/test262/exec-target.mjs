#!/usr/bin/env node
// Cross-platform execution of asm.js native binaries.
//
// test262 workdirs name binaries `t123` with no platform in the filename, so
// run.sh filename-detection would treat them as host. This module honors an
// explicit `--target` instead:
//   macos-arm64          host-native spawn
//   macos-x64 on arm64   spawn (Rosetta 2)
//   linux-*              persistent Docker container, workdir mounted at /work
//   windows-x64          Wine
//
// Docker uses one long-lived container per executor (not `docker run --rm` per
// test) so a stride-5 sample does not pay image-start per binary.

import { spawn, execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getTargetInfo, listTargets, resolveTarget } from "../../compiler/core/platform.js";

export const RELEASE_TARGETS = listTargets()
  .filter((t) => t.release)
  .map((t) => t.name);

function commandExists(cmd) {
  const r = spawnSync("/bin/sh", ["-c", "command -v -- " + JSON.stringify(cmd)], {
    stdio: "ignore",
  });
  return r.status === 0;
}

let dockerCache;
export function dockerAvailable() {
  if (dockerCache !== undefined) return dockerCache;
  if (!commandExists("docker")) {
    dockerCache = false;
    return false;
  }
  try {
    execFileSync("docker", ["info"], { stdio: "ignore", timeout: 8000 });
    dockerCache = true;
  } catch {
    dockerCache = false;
  }
  return dockerCache;
}

export function wineCommand() {
  if (commandExists("wine64")) return "wine64";
  if (commandExists("wine")) return "wine";
  return null;
}

export function hostPlatform() {
  const os = process.platform === "darwin" ? "macos"
    : process.platform === "win32" ? "windows"
    : process.platform;
  const arch = process.arch === "arm64" || process.arch === "aarch64" ? "arm64" : "x64";
  return { os, arch, name: os + "-" + arch };
}

export function dockerPlatform(info) {
  return "linux/" + (info.arch === "x64" ? "amd64" : "arm64");
}

export function describeRunner(target) {
  let resolved;
  try {
    resolved = resolveTarget(target);
  } catch (e) {
    return {
      runnable: false,
      mode: "unknown",
      target,
      resolved: null,
      reason: e && e.message ? e.message : String(e),
    };
  }
  const info = getTargetInfo(resolved);
  const host = hostPlatform();
  if (info.os === "macos") {
    if (host.os !== "macos") {
      return {
        runnable: false, mode: "unavailable", target, resolved,
        reason: "macOS binaries cannot run on " + host.os,
      };
    }
    if (info.arch === host.arch) {
      return {
        runnable: true, mode: "direct", target, resolved,
        reason: "host-native " + resolved,
      };
    }
    if (host.arch === "arm64" && info.arch === "x64") {
      return {
        runnable: true, mode: "rosetta", target, resolved,
        reason: "Rosetta 2",
      };
    }
    return {
      runnable: false, mode: "unavailable", target, resolved,
      reason: "cannot run " + info.arch + " macOS binary on " + host.arch,
    };
  }
  if (info.os === "linux") {
    if (host.os === "linux" && info.arch === host.arch) {
      return {
        runnable: true, mode: "direct", target, resolved,
        reason: "host-native " + resolved,
      };
    }
    if (dockerAvailable()) {
      return {
        runnable: true, mode: "docker", target, resolved,
        reason: "Docker " + dockerPlatform(info),
        qemu: info.arch !== host.arch,
      };
    }
    return {
      runnable: false, mode: "unavailable", target, resolved,
      reason: "linux target needs Docker, or a matching Linux host",
    };
  }
  if (info.os === "windows") {
    if (host.os === "windows") {
      return {
        runnable: true, mode: "direct", target, resolved,
        reason: "host-native " + resolved,
      };
    }
    const wine = wineCommand();
    if (wine) {
      return {
        runnable: true, mode: "wine", target, resolved,
        reason: wine,
      };
    }
    return {
      runnable: false, mode: "unavailable", target, resolved,
      reason: "windows target needs Wine (wine64/wine)",
    };
  }
  return {
    runnable: false, mode: "unavailable", target, resolved,
    reason: "no runner for " + resolved,
  };
}

// Wine on macOS reparents the PE under wineserver; it is not in `wine`'s
// process group. `kill(-pgid)` therefore leaves a spinning tNNN at 96% CPU
// and `close` never fires (official yield/arguments-object-attributes
// runMs=875s against a 60s budget). Match the PE path in `ps` and SIGKILL.
function killPidsMatching(needle) {
  if (!needle || needle.length < 8) return;
  let out = "";
  try {
    const r = spawnSync("/bin/ps", ["-axo", "pid=,command="], {
      encoding: "utf8",
      timeout: 2000,
    });
    out = r.stdout || "";
  } catch {
    return;
  }
  for (const line of out.split("\n")) {
    const s = line.trim();
    const sp = s.indexOf(" ");
    if (sp < 0) continue;
    const pid = Number(s.slice(0, sp));
    if (!pid || pid === process.pid) continue;
    if (s.slice(sp + 1).indexOf(needle) >= 0) {
      try { process.kill(pid, "SIGKILL"); } catch {}
    }
  }
}

export function spawnCaptured(cmd, args, timeoutMs, env, opts) {
  return new Promise((resolvePromise) => {
    let stdout = "", stderr = "", done = false, timedOut = false;
    let child;
    let settleTimer = null;
    const killGroup = !!(opts && opts.killGroup);
    const killPath = opts && opts.killPath;
    try {
      child = spawn(cmd, args, {
        stdio: ["ignore", "pipe", "pipe"],
        env: env || process.env,
        // Wine spawns wineserver + the PE as children. SIGKILL on `wine`
        // alone leaves those running and pins the prefix. New process group
        // so a timeout can kill the whole tree.
        detached: killGroup,
      });
    } catch (err) {
      resolvePromise({
        code: null, signal: null, stdout: "", stderr: String(err),
        timedOut: false, spawnError: true,
      });
      return;
    }
    const finish = (payload) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (settleTimer) clearTimeout(settleTimer);
      resolvePromise(payload);
    };
    const reap = () => {
      if (killGroup && child.pid) {
        try { process.kill(-child.pid, "SIGKILL"); } catch {}
      }
      try { child.kill("SIGKILL"); } catch {}
      if (killPath) killPidsMatching(killPath);
      try { child.stdout.destroy(); } catch {}
      try { child.stderr.destroy(); } catch {}
      // Per-job WINEPREFIX: kill only this prefix's wineserver. A shared
      // ~/.wine server was pinned by one hung PE and serialized siblings.
      if (opts && opts.winePrefix) {
        try {
          spawnSync(cmd, ["wineserver", "-k"], {
            env: { ...(env || process.env), WINEPREFIX: opts.winePrefix },
            timeout: 5000,
            stdio: "ignore",
          });
        } catch {}
      }
    };
    const timer = setTimeout(() => {
      if (done) return;
      timedOut = true;
      reap();
      // Hung PE keeps the pipes open; do not wait on `close`.
      settleTimer = setTimeout(() => {
        finish({
          code: null, signal: "SIGKILL", stdout, stderr,
          timedOut: true, spawnError: false,
        });
      }, 2000);
    }, timeoutMs);
    child.stdout.on("data", (d) => { if (stdout.length < 65536) stdout += d; });
    child.stderr.on("data", (d) => { if (stderr.length < 65536) stderr += d; });
    child.on("error", (err) => {
      finish({
        code: null, signal: null, stdout,
        stderr: stderr + String(err), timedOut, spawnError: true,
      });
    });
    child.on("close", (code, signal) => {
      finish({
        code, signal, stdout, stderr, timedOut, spawnError: false,
      });
    });
  });
}

export class TargetExecutor {
  constructor(target) {
    this.cap = describeRunner(target);
    this.target = this.cap.resolved || target;
    this.info = this.cap.resolved ? getTargetInfo(this.cap.resolved) : null;
    this.container = null;
    this.workdir = null;
    this.wine = this.cap.mode === "wine" ? wineCommand() : null;
    this.wineJobs = 1;
    this.winePrefixes = [];
    this.wineFree = [];
    this.image = process.env.ASMJS_DOCKER_IMAGE || "ubuntu:24.04";
  }

  capability() {
    return this.cap;
  }

  async start(workdir, opts) {
    this.workdir = resolve(workdir);
    this.wineJobs = Math.max(1, (opts && opts.jobs) || 1);
    if (!this.cap.runnable) {
      throw new Error("target " + this.target + " is not runnable: " + this.cap.reason);
    }
    if (this.cap.mode === "docker") await this._startDocker();
    else if (this.cap.mode === "wine") await this._startWine();
  }

  wineEnv() {
    return {
      ...process.env,
      WINEDEBUG: process.env.WINEDEBUG || "-all",
      // Skip the menu-builder stub; a hung winedbg crash dialog pins wineserver
      // and serializes the rest of an official sample.
      WINEDLLOVERRIDES: process.env.WINEDLLOVERRIDES || "winemenubuilder.exe=d;winedbg.exe=d",
    };
  }

  async _startWine() {
    // One WINEPREFIX per job. A hung PE pins that prefix's wineserver only;
    // siblings keep their own server. Shared ~/.wine serialized the sample
    // (unary-minus timed out while an unreaped PE spun at 96%).
    this.winePrefixes = [];
    this.wineFree = [];
    const root = join(this.workdir, "winepfx");
    mkdirSync(root, { recursive: true });
    for (let i = 0; i < this.wineJobs; i++) {
      const prefix = join(root, "j" + i);
      mkdirSync(prefix, { recursive: true });
      const env = { ...this.wineEnv(), WINEPREFIX: prefix };
      const r = await spawnCaptured(this.wine, ["wineboot", "--init"], 90000, env, { killGroup: true });
      if (r.spawnError) {
        throw new Error("wineboot failed for prefix " + i + ": " + r.stderr);
      }
      await spawnCaptured(
        this.wine,
        ["reg", "add", "HKCU\\Software\\Wine\\WineDbg", "/v", "ShowCrashDialog", "/t", "REG_DWORD", "/d", "0", "/f"],
        30000,
        env,
        { killGroup: true },
      );
      this.winePrefixes.push(prefix);
      this.wineFree.push(prefix);
    }
  }

  async _startDocker() {
    const name = "asmjs-t262-" + this.target + "-" + process.pid;
    this.container = name;
    try {
      execFileSync("docker", ["rm", "-f", name], { stdio: "ignore", timeout: 15000 });
    } catch {}
    const platform = dockerPlatform(this.info);
    const args = [
      "run", "-d",
      "--name", name,
      "--platform", platform,
      "--network", "none",
      "--init",
      "-v", this.workdir + ":/work",
      this.image,
      "sleep", "infinity",
    ];
    const r = spawnSync("docker", args, { encoding: "utf8", timeout: 180000 });
    if (r.status !== 0) {
      this.container = null;
      throw new Error(
        "docker run failed for " + this.target + " (" + platform + "): " +
        String(r.stderr || r.stdout || r.status).trim(),
      );
    }
    const ping = spawnSync(
      "docker",
      ["exec", name, "sh", "-c", "test -d /work && echo ok"],
      { encoding: "utf8", timeout: 30000 },
    );
    if (ping.status !== 0 || !String(ping.stdout).includes("ok")) {
      try {
        execFileSync("docker", ["rm", "-f", name], { stdio: "ignore", timeout: 15000 });
      } catch {}
      this.container = null;
      throw new Error(
        "docker exec ping failed for " + this.target + ": " +
        String(ping.stderr || ping.stdout || ping.status).trim(),
      );
    }
  }

  async run(binPath, timeoutMs) {
    if (!existsSync(binPath)) {
      return {
        code: null, signal: null, stdout: "",
        stderr: "binary not found: " + binPath,
        timedOut: false, spawnError: true,
      };
    }
    try { chmodSync(binPath, 0o755); } catch {}
    const mode = this.cap.mode;
    if (mode === "direct" || mode === "rosetta") {
      return spawnCaptured(binPath, [], timeoutMs);
    }
    if (mode === "wine") {
      const prefix = this.wineFree.length
        ? this.wineFree.pop()
        : (this.winePrefixes[0] || null);
      const env = { ...this.wineEnv() };
      if (prefix) env.WINEPREFIX = prefix;
      try {
        return await spawnCaptured(this.wine, [binPath], timeoutMs, env, {
          killGroup: true,
          killPath: binPath,
          winePrefix: prefix,
        });
      } finally {
        if (prefix) this.wineFree.push(prefix);
      }
    }
    if (mode === "docker") {
      if (!this.container) {
        return {
          code: null, signal: null, stdout: "",
          stderr: "docker executor was not started",
          timedOut: false, spawnError: true,
        };
      }
      const innerMs = Math.max(1000, timeoutMs);
      const secs = (innerMs / 1000).toFixed(3);
      const inner = "/work/" + basename(binPath);
      const r = await spawnCaptured(
        "docker",
        ["exec", this.container, "timeout", "--signal=KILL", secs, inner],
        timeoutMs + 2000,
      );
      if (r.code === 124) {
        r.timedOut = true;
        r.signal = r.signal || "SIGKILL";
      } else if (r.code > 128 && r.code < 160 && !r.signal) {
        // docker exec reports fatal signals as 128+signo (139 = SIGSEGV), not
        // as Node's `signal` field. Classify them as crashes, not assertion FAIL.
        const names = {
          129: "SIGHUP", 130: "SIGINT", 132: "SIGILL", 134: "SIGABRT",
          136: "SIGFPE", 137: "SIGKILL", 139: "SIGSEGV", 143: "SIGTERM",
        };
        r.signal = names[r.code] || ("SIG" + (r.code - 128));
      }
      return r;
    }
    return {
      code: null, signal: null, stdout: "",
      stderr: "no runner mode for " + this.target,
      timedOut: false, spawnError: true,
    };
  }

  async close() {
    if (this.wine && this.winePrefixes && this.winePrefixes.length) {
      for (const prefix of this.winePrefixes) {
        try {
          spawnSync(this.wine, ["wineserver", "-k"], {
            env: { ...this.wineEnv(), WINEPREFIX: prefix },
            timeout: 10000,
            stdio: "ignore",
          });
        } catch {}
      }
      this.winePrefixes = [];
      this.wineFree = [];
    }
    if (this.container) {
      try {
        execFileSync("docker", ["rm", "-f", this.container], { stdio: "ignore", timeout: 20000 });
      } catch {}
      this.container = null;
    }
  }
}

export function printCapabilityTable(stream) {
  const out = stream || process.stderr;
  const host = hostPlatform();
  out.write("host " + host.name + "\n");
  for (const t of RELEASE_TARGETS) {
    const d = describeRunner(t);
    const flag = d.runnable ? "RUN " : "SKIP";
    out.write(flag + "  " + t.padEnd(14) + "  mode=" + d.mode + "  " + d.reason + "\n");
  }
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  printCapabilityTable(process.stdout);
}
