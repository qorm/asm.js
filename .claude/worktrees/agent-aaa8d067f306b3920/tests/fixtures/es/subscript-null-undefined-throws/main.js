// computed member access null[k] / undefined[k] must throw a catchable TypeError
// (not segfault); mirror of the static .x form.
const k = "x";
try { console.log(null[k]); } catch (e) { console.log(e instanceof TypeError, e.message); }
try { console.log(undefined[k]); } catch (e) { console.log(e instanceof TypeError, e.message); }
try { console.log(null[0]); } catch (e) { console.log(e.name); }
// normal subscript still works
const arr = [10, 20, 30];
console.log(arr[1]);
const o = { a: 5 };
const key = "a";
console.log(o[key]);
