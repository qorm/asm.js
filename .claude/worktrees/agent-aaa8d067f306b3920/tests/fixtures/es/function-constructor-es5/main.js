// [#69] ES5 function used as constructor with `new`
function Point(x, y) {
  this.x = x;
  this.y = y;
  this.sum = x + y;
}
var p = new Point(3, 4);
console.log(p.x, p.y, p.sum);
console.log(p instanceof Point);

// no-arg constructor
function Counter() { this.n = 0; }
console.log(new Counter().n);

// explicit object return overrides the new instance
function Boxed(v) { this.v = v; return { boxed: v * 10 }; }
var b = new Boxed(5);
console.log(b.boxed);

// returning a primitive is ignored -> instance is returned
function Prim(v) { this.v = v; return 42; }
console.log(new Prim(7).v);

// two distinct constructors -> instanceof discriminates
function A() { this.t = "a"; }
function B() { this.t = "b"; }
var a = new A();
console.log(a instanceof A, a instanceof B);
