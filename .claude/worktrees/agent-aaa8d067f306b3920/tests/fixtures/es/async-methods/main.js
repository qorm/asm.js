// async methods return Promises: class AND object-literal, with await/then/reject/this.
function show(tag, v) { console.log(tag + " " + v); }

class C {
  async m(a) { return a + 100; }
  async withThis() { const x = await Promise.resolve(this.base); return x + 1; }
  async fail() { throw new Error("boom"); }
}
C.prototype.base = 40;

const obj = {
  v: 42,
  async n() { return this.v; },
  async add(a, b) { const x = await Promise.resolve(a); return x + b; },
};

(async () => {
  show("classm", await new C().m(7));           // 107
  show("classthis", await new C().withThis());  // 41
  try { await new C().fail(); } catch (e) { show("classcatch", e.message); } // boom
  show("objn", await obj.n());                  // 42
  show("objadd", await obj.add(3, 4));          // 7
  // .then() chaining works on an async-method result.
  await obj.add(1, 1).then(v => show("objthen", v)); // 2
})();
