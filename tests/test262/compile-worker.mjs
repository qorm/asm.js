// Persistent compile worker: load the compiler graph once, then compile each
// IPC job with a fresh Compiler. Parent kills this process on compile timeout.
import { compileOnce } from "./compile-job.mjs";

process.on("disconnect", () => process.exit(0));
process.on("message", (msg) => {
  if (!msg || msg.type === "shutdown") {
    process.exit(0);
    return;
  }
  if (msg.type !== "compile") return;
  const t0 = Date.now();
  try {
    const out = compileOnce(
      msg.sourcePath,
      msg.outputPath,
      msg.target,
      msg.cacheIdentity
    );
    process.send({
      type: "result",
      id: msg.id,
      ok: true,
      cacheHit: out.cacheHit,
      compileMs: out.compileMs,
    });
  } catch (e) {
    process.send({
      type: "result",
      id: msg.id,
      ok: false,
      cacheHit: false,
      compileMs: Date.now() - t0,
      error: e && e.message ? String(e.message) : String(e),
    });
  }
});

process.send({ type: "ready" });
