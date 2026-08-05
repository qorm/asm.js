// Proxy apply/construct traps driven by the argc call-ABI.
function target(a, b) { return (a || 0) * (b || 0); }

// apply trap: correct argsArray (length + values + real undefined)
const p1 = new Proxy(target, { apply(t, thisArg, args) { return args.length + ":" + args.join("|"); } });
console.log("apply " + p1(1, 2, 3));            // 3:1|2|3
console.log("applyz " + p1());                  // 0:
const p2 = new Proxy(target, { apply(t, thisArg, args) { return args.length + ":" + String(args[1]); } });
console.log("applyu " + p2(1, undefined, 3));   // 3:undefined

// apply trap thisArg via method receiver
const p3 = new Proxy(target, { apply(t, thisArg, args) { return thisArg.tag; } });
const holder = { tag: "T", m: p3 };
console.log("this " + holder.m());              // T

// no apply trap: forward to target with original args
const p4 = new Proxy(target, {});
console.log("fwd " + p4(6, 7));                 // 42

// typeof callable proxy is "function"; object proxy stays "object"
console.log("tf " + typeof p4);                 // function
console.log("to " + typeof new Proxy({}, {}));  // object

// construct trap: args array + newTarget
class C { constructor(x) { this.x = x; } }
const pc = new Proxy(C, { construct(t, args, nt) { return { n: args.length, s: args.join("+"), isP: nt === pc }; } });
const made = new pc(7, 8);
console.log("cons " + made.n + " " + made.s + " " + made.isP); // 2 7+8 true

// construct spread
const pcs = new Proxy(C, { construct(t, args) { return { n: args.length }; } });
const arr = [1, 2, 3];
console.log("consspread " + new pcs(...arr).n); // 3

// no construct trap: forward construction (instanceof works)
const pf = new Proxy(C, {});
const inst = new pf(21);
console.log("consfwd " + inst.x + " " + (inst instanceof C)); // 21 true

// get trap unaffected
const pg = new Proxy({}, { get(t, k) { return "G:" + k; } });
console.log("get " + pg.foo);                   // G:foo
