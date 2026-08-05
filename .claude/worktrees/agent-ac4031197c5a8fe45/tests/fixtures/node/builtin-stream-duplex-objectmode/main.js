import { Duplex, Readable } from "node:stream";

// Object-mode Readable.from an array of objects, collected on 'data'.
const nums = [];
Readable.from([{ n: 1 }, { n: 2 }, { n: 3 }])
  .on("data", (o) => nums.push(o.n))
  .on("end", () => {
    console.log("objmode:" + nums.join(","));

    // Duplex: independent readable + writable sides.
    const wrote = [];
    const readOut = [];
    const d = new Duplex({
      read() { this.push("R1"); this.push("R2"); this.push(null); },
      write(chunk, enc, cb) { wrote.push(String(chunk)); cb(); },
    });
    d.on("data", (c) => readOut.push(String(c)));
    d.on("end", () => console.log("duplex-read:" + readOut.join(",")));
    d.on("finish", () => console.log("duplex-write:" + wrote.join(",")));
    d.write("W1");
    d.write("W2");
    d.end();
  });
