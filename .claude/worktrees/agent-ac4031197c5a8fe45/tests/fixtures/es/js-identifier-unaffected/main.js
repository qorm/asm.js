// `js` remains an ordinary identifier everywhere except statement-position
// same-line spawn. This file is valid standard JS (node-diffable).
const js = 5;
console.log("a " + (js + 1));      // 6
function f(js) { return js * 2; }
console.log("b " + f(3));          // 6
const o = { js: 7 };
console.log("c " + o.js);          // 7
function g(v) { return v + 100; }
const js2 = { js: g };
console.log("d " + js2.js(1));     // 101
let js3 = 0;
js3 = 9;
console.log("e " + js3);           // 9
