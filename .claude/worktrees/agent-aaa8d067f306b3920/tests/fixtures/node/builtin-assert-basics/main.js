import assert from "node:assert";

assert.ok(1);
assert.equal(2, 2);
assert.strictEqual("a", "a");
assert.deepEqual([1, 2, 3], [1, 2, 3]);
assert.deepEqual({ a: 1, b: [2, 3] }, { a: 1, b: [2, 3] });
assert.throws(() => { throw new Error("boom"); });

let m1 = false;
try { assert.strictEqual(1, 2); } catch (e) { m1 = true; }
console.log(m1);

let m2 = false;
try { assert.deepEqual([1, 2], [1, 3]); } catch (e) { m2 = true; }
console.log(m2);

let m3 = false;
try { assert.throws(() => { return 1; }); } catch (e) { m3 = true; }
console.log(m3);

console.log("ok");
