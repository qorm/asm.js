import { Readable, Writable } from "node:stream";

// Readable (custom _read, flowing) piped into a Writable collector.
const src = new Readable({
  read() {
    this.push("hello ");
    this.push("world");
    this.push(null);
  },
});
const chunks = [];
const dst = new Writable({
  write(chunk, enc, cb) { chunks.push(String(chunk)); cb(); },
});
dst.on("finish", () => {
  console.log("piped:" + chunks.join(""));

  // Now demonstrate read()/'readable' paused consumption (sequenced after
  // the pipe finishes so output ordering is deterministic).
  const r2 = new Readable({ read() { this.push("a"); this.push("b"); this.push(null); } });
  const got = [];
  r2.on("readable", () => {
    let c;
    while ((c = r2.read()) !== null) got.push(String(c));
  });
  r2.on("end", () => console.log("read:" + got.join("")));
});
src.pipe(dst);
