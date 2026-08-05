// arguments.length via the argc call-ABI: real undefined args are counted,
// and no call path leaves a stale count behind.
function argc() { return arguments.length; }
function vals() { return String(arguments[0]) + "," + String(arguments[1]) + "," + String(arguments[2]); }

// real undefineds are counted
console.log("mid " + argc(1, undefined, 3));       // 3
console.log("trail " + argc(1, undefined));        // 2
console.log("allundef " + argc(undefined, undefined)); // 2
console.log("zero " + argc());                     // 0
console.log("vals " + vals(1, undefined, 3));      // 1,undefined,3

// stale-argc adversarial: mixed direct/apply/call/spread/bind/method/new sequences
console.log("seq1 " + argc(1, 2, 3) + " " + argc.apply(null, [4]) + " " + argc(5, 6)); // 3 1 2
console.log("seq2 " + argc.apply(null, [1, 2, 3, 4]) + " " + argc());                  // 4 0
console.log("seq3 " + argc.call(null, 9) + " " + argc.call(null) + " " + argc(1, 2));  // 1 0 2
const spr = [1, 2, 3];
console.log("seq4 " + argc(...spr) + " " + argc(7));                                   // 3 1
const bnd = argc.bind(null, 1, 2);
console.log("seq5 " + bnd(3) + " " + bnd() + " " + argc(9));                           // 3 2 1
const om = { m() { return arguments.length; } };
console.log("seq6 " + om.m(1, 2, 3, 4) + " " + argc(5));                               // 4 1
class K { constructor(a) { this.a = a; } }
new K(1, 2);
console.log("seq7 " + argc(7, 8, 9));                                                  // 3

// builtin callback arg counts
console.log("cb " + [10].map(function () { return arguments.length; })[0]);            // 3
console.log("red " + [1, 2].reduce(function () { return arguments.length; }, 0));      // 4
