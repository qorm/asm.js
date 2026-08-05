// arguments object inside coroutine bodies (generators + async fns) via CORO_ARGC.
function* g() { yield arguments.length; yield arguments[1]; }
const it = g(10, 20, 30);
console.log("gen " + it.next().value + " " + it.next().value); // 3 20

function* gu() { yield arguments.length; }
console.log("genundef " + gu(1, undefined, 3).next().value);   // 3

const gc = function* () { yield arguments.length; };
console.log("genclosure " + gc(7, 8).next().value);            // 2

function* gp(a, b) { yield a + b; yield arguments.length; }
const it2 = gp(3, 4);
console.log("genparams " + it2.next().value + " " + it2.next().value); // 7 2

async function af() { return arguments.length + ":" + String(arguments[1]); }
async function az() { return arguments.length; }
async function* ag() { yield arguments.length; }

(async () => {
  console.log("async " + (await af(5, undefined)));  // 2:undefined
  console.log("asyncz " + (await az()));             // 0
  for await (const v of ag(1, 2, 3)) console.log("agen " + v); // 3
})();
