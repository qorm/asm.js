// Fixed-size pool of resident Node child processes that compile via IPC.
import { fork } from "child_process";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";
import os from "os";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_WORKER = join(__dirname, "compile-worker.mjs");

export class CompilePool {
  constructor(opts) {
    this.size = Math.max(1, opts.size || 1);
    this.workerFile = opts.workerFile || DEFAULT_WORKER;
    this.repo = opts.repo || resolve(__dirname, "..", "..");
    this.env = opts.env || process.env;
    this.workers = [];
    this.idle = [];
    this.waiters = [];
    this.closed = false;
    this.seq = 0;
  }

  async start() {
    const spawned = [];
    for (let i = 0; i < this.size; i++) spawned.push(this._spawn());
    this.workers = await Promise.all(spawned);
    this.idle = this.workers.slice();
    return this;
  }

  async compile(job) {
    if (this.closed) {
      return {
        ok: false, timedOut: false, signal: null, code: 1,
        stderr: "compile pool closed", cacheHit: null, compileMs: 0,
      };
    }
    const w = await this._acquire();
    if (!w) {
      return {
        ok: false, timedOut: false, signal: null, code: 1,
        stderr: "compile pool closed", cacheHit: null, compileMs: 0,
      };
    }
    const id = ++this.seq;
    const timeoutMs = job.timeoutMs || 30000;
    return new Promise((resolvePromise) => {
      let settled = false;
      const finish = (msg) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        w.job = null;
        if (!w.dead && !this.closed) this._release(w);
        resolvePromise(msg);
      };
      const timer = setTimeout(() => {
        w.dead = true;
        try { w.child.kill("SIGKILL"); } catch {}
        finish({
          ok: false,
          timedOut: true,
          signal: "SIGKILL",
          code: null,
          stderr: "compile timeout",
          cacheHit: null,
          compileMs: timeoutMs,
        });
      }, timeoutMs);

      w.job = { id, finish, stderr: "" };
      try {
        w.child.send({
          type: "compile",
          id,
          sourcePath: job.sourcePath,
          outputPath: job.outputPath,
          target: job.target,
          cacheIdentity: job.cacheIdentity || null,
        });
      } catch (e) {
        finish({
          ok: false, timedOut: false, signal: null, code: 1,
          stderr: String(e && e.message ? e.message : e),
          cacheHit: null, compileMs: 0,
        });
      }
    });
  }

  async close() {
    this.closed = true;
    for (const waiter of this.waiters) {
      waiter(null);
    }
    this.waiters = [];
    const kids = this.workers.slice();
    this.workers = [];
    this.idle = [];
    await Promise.all(kids.map((w) => this._stop(w)));
  }

  _acquire() {
    return new Promise((resolvePromise) => {
      if (this.closed) {
        resolvePromise(null);
        return;
      }
      while (this.idle.length) {
        const w = this.idle.pop();
        if (w && !w.dead) {
          resolvePromise(w);
          return;
        }
      }
      this.waiters.push(resolvePromise);
    });
  }

  _release(w) {
    if (!w || w.dead || this.closed) return;
    const waiter = this.waiters.shift();
    if (waiter) waiter(w);
    else this.idle.push(w);
  }

  _spawn() {
    return new Promise((resolvePromise, reject) => {
      const child = fork(this.workerFile, [], {
        cwd: this.repo,
        env: this.env,
        stdio: ["ignore", "pipe", "pipe", "ipc"],
      });
      // Wine/qemu PE/ELF runs share this host with 4 compile workers.
      // At nice 0 the workers sit at 100%+ and a 2s wine test wall-clocks
      // past the 60s emulator run floor (findIndex/length-as-symbol).
      try { os.setPriority(child.pid, 10); } catch {}
      const w = { child, dead: false, replaced: false, job: null, ready: false };
      const startupTimer = setTimeout(() => {
        if (w.ready) return;
        w.dead = true;
        try { child.kill("SIGKILL"); } catch {}
        reject(new Error("compiler worker startup timeout"));
      }, 10000);

      const onReady = (msg) => {
        if (!msg || msg.type !== "ready") return;
        clearTimeout(startupTimer);
        child.off("message", onReady);
        w.ready = true;
        resolvePromise(w);
      };
      child.on("message", onReady);
      child.on("message", (msg) => {
        if (!msg || msg.type !== "result" || !w.job || msg.id !== w.job.id) return;
        const extra = [w.job.stderr, msg.error || "", msg.stderr || ""]
          .filter(Boolean).join("\n");
        w.job.finish({
          ok: !!msg.ok,
          timedOut: false,
          signal: null,
          code: msg.ok ? 0 : 1,
          stderr: extra,
          cacheHit: Object.prototype.hasOwnProperty.call(msg, "cacheHit")
            ? msg.cacheHit
            : null,
          compileMs: msg.compileMs || 0,
        });
      });
      child.stderr.on("data", (d) => {
        const s = String(d);
        if (w.job && w.job.stderr.length < 65536) w.job.stderr += s;
      });
      child.stdout.on("data", () => {});
      child.on("exit", () => {
        clearTimeout(startupTimer);
        w.dead = true;
        if (w.job) {
          w.job.finish({
            ok: false,
            timedOut: false,
            signal: "exit",
            code: null,
            stderr: (w.job.stderr || "") || "compiler worker exited",
            cacheHit: null,
            compileMs: 0,
          });
        }
        if (!w.ready) {
          reject(new Error("compiler worker exited before ready"));
        } else if (!this.closed) {
          this._replace(w);
        }
      });
      child.on("error", (err) => {
        if (!w.ready) {
          clearTimeout(startupTimer);
          reject(err);
        }
        else if (w.job) {
          w.job.finish({
            ok: false, timedOut: false, signal: null, code: 1,
            stderr: String(err), cacheHit: null, compileMs: 0,
          });
        }
      });
    });
  }

  async _replace(w) {
    if (!w || w.replaced || this.closed) return;
    w.replaced = true;
    const idx = this.workers.indexOf(w);
    try {
      const nw = await this._spawn();
      if (this.closed) {
        await this._stop(nw);
        return;
      }
      if (idx >= 0) this.workers[idx] = nw;
      else this.workers.push(nw);
      this._release(nw);
    } catch (e) {
      const waiter = this.waiters.shift();
      if (waiter) waiter(null);
      if (idx >= 0) this.workers.splice(idx, 1);
    }
  }

  _stop(w) {
    return new Promise((resolvePromise) => {
      if (!w || !w.child) {
        resolvePromise();
        return;
      }
      w.dead = true;
      const child = w.child;
      if (child.exitCode !== null || child.signalCode) {
        resolvePromise();
        return;
      }
      const done = () => {
        clearTimeout(killTimer);
        resolvePromise();
      };
      child.once("exit", done);
      try { child.send({ type: "shutdown" }); } catch {}
      const killTimer = setTimeout(() => {
        try { child.kill("SIGKILL"); } catch {}
        resolvePromise();
      }, 500);
    });
  }
}

export function aggregateTiming(results) {
  const t = {
    compileMsSum: 0,
    runMsSum: 0,
    warm: 0,
    cold: 0,
    unknown: 0,
    warmCompileMs: 0,
    coldCompileMs: 0,
  };
  for (const r of results) {
    const c = Number(r.compileMs) || 0;
    const u = Number(r.runMs) || 0;
    t.compileMsSum += c;
    t.runMsSum += u;
    if (r.cacheHit === true) {
      t.warm++;
      t.warmCompileMs += c;
    } else if (r.cacheHit === false) {
      t.cold++;
      t.coldCompileMs += c;
    } else {
      t.unknown++;
    }
  }
  t.warmAvgMs = t.warm ? t.warmCompileMs / t.warm : 0;
  t.coldAvgMs = t.cold ? t.coldCompileMs / t.cold : 0;
  return t;
}

export function formatTiming(t, wallMs) {
  const s = (ms) => (ms / 1000).toFixed(1);
  const avg = (ms) => ms.toFixed(1);
  let line = `timing: wall=${s(wallMs)}s compile-sum=${s(t.compileMsSum)}s run-sum=${s(t.runMsSum)}s`;
  line += `  cache warm=${t.warm}` + (t.warm ? ` (avg ${avg(t.warmAvgMs)}ms)` : "");
  line += `  cold=${t.cold}` + (t.cold ? ` (avg ${avg(t.coldAvgMs)}ms)` : "");
  if (t.unknown) {
    line += `  unknown=${t.unknown} (compileFile/cache helper did not report cacheHit)`;
  }
  return line;
}
