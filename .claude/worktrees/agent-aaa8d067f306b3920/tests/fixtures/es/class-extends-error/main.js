class MyErr extends Error {
  constructor(m) { super(m); this.name = "MyErr"; }
}
const e = new MyErr("boom");
console.log(e instanceof Error, e instanceof MyErr, e.name, e.message);

class CodeErr extends TypeError {
  constructor(m, code) { super(m); this.code = code; }
}
const c = new CodeErr("bad", "E123");
console.log(c instanceof Error, c instanceof TypeError, c.name, c.message, c.code);

class Caused extends Error {
  constructor(m, o) { super(m, o); this.name = "Caused"; }
}
const cd = new Caused("wrap", { cause: "root" });
console.log(cd.cause, cd.name, cd.message);

const ag = new AggregateError([new Error("a"), new Error("b")], "multi");
console.log(ag instanceof Error, ag.message, ag.errors.length);

try { throw new MyErr("caught"); } catch (x) { console.log("catch", x.message, x instanceof Error); }
