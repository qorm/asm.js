// Embedded-NUL transparency in comparison: _strcmp compares by length, not
// stopping at the first \x00. "A\0B" and "A\0C" must differ at index 2.
var x = String.fromCharCode(65, 0, 66); // A\0B
var y = String.fromCharCode(65, 0, 67); // A\0C
var z = String.fromCharCode(65, 0, 66); // A\0B
console.log(x === y, x === z, x !== y);
// relational: shorter prefix is less; byte after NUL decides ordering
console.log(x < y, y < x);
var ab = String.fromCharCode(97, 0);     // "a\0" length 2
var abc = String.fromCharCode(97, 0, 98); // "a\0b" length 3
console.log(ab < abc, abc < ab);
// sort stability over embedded NUL
var arr = [y, x, abc, ab];
arr.sort();
console.log(arr.map(function (s) { return s.length; }).join(","));
console.log(arr[0] === ab, arr[3] === y);
