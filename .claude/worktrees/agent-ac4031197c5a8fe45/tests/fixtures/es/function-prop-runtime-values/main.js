function f(){}
const g = f;             // identifier alias
g.x = 1;
console.log("alias", g.x, f.x);           // 1 1 (same identity)
function factory(){ return function(){}; }
const a = factory();     // call result
a.tag = 9;
console.log("factory", a.tag);            // 9
function decorate(fn){ fn.marked = true; return fn; }  // param write
const d = decorate(() => {});
console.log("param", d.marked);           // true
const arr = [function(){}, function(){}]; // element
arr[0].idx = 0;
console.log("elem", arr[0].idx);          // 0
