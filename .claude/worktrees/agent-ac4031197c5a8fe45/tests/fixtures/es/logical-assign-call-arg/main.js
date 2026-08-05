// Logical-assignment (and plain/compound assignment) as a CALL ARGUMENT / sub-expression.
const o = { x: 0, y: 5, z: null };
console.log("r1 " + (o.x ||= 5));   // 5  (0 falsy -> assign)
console.log("r2 " + (o.y ||= 9));   // 5  (truthy -> keep)
console.log("r3 " + (o.z ??= 42));  // 42 (null -> assign)
console.log("r4 " + (o.y &&= 3));   // 3  (truthy -> assign)
let a;
console.log("r5 " + (a = 7));       // 7  (plain assignment as arg)
let b = 4;
console.log("r6 " + (b += 6));      // 10 (compound assignment as arg)
console.log("final " + o.x + " " + o.y + " " + o.z); // 5 3 42
