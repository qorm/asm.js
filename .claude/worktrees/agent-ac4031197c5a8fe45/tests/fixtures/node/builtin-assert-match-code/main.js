import assert from "node:assert";
try { assert.strictEqual(1, 2); } catch (e) { console.log("se", e.code); }
try { assert.deepStrictEqual({ a: 1 }, { a: 2 }); } catch (e) { console.log("dse", e.code); }
assert.match("hello", /ell/);
console.log("match-ok");
assert.doesNotMatch("hello", /xyz/);
console.log("dnm-ok");
try { assert.match("hello", /xyz/); } catch (e) { console.log("m-fail", e.code); }
assert.throws(() => { throw new Error("boom"); }, /boom/);
console.log("throws-regex-ok");
try { assert.throws(() => { throw new Error("a"); }, /b/); } catch (e) { console.log("throws-mismatch", e.code); }
try { assert.ifError(new Error("bad")); } catch (e) { console.log("iferror", e.message); }
assert.ifError(null);
assert.strict.strictEqual(3, 3);
console.log("done");
