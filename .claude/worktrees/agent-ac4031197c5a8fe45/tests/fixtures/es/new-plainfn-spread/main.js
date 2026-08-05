function F(a, b, c) { this.a = a; this.b = b; this.c = c; }
const x = new F(...[1, 2, 3]);
console.log(x.a, x.b, x.c);
const y = new F(...[7, 8]);
console.log(y.a, y.b, y.c);
console.log(new F(10, 20, 30).b);
const m = new F(100, ...[200, 300]);
console.log(m.a, m.b, m.c);
const r = Reflect.construct(F, [4, 5, 6]);
console.log(r.a, r.b, r.c, r instanceof F);
class C { constructor(p, q) { this.p = p; this.q = q; } }
console.log(new C(...[11, 22]).p);
