// String.raw: raw (un-cooked) quasi text with expression substitution.
console.log(String.raw`a\nb`);            // backslash-n preserved
console.log(String.raw`C:\temp\x`);        // Windows-style path, backslashes raw
console.log(String.raw`v=${1 + 2}!`);      // expression substituted
console.log(String.raw`\t${"X"}\r`);       // raw \t and \r around a value
console.log(JSON.stringify(String.raw`a\nb`)); // "a\\nb"
// raw vs cooked: a cooked-consuming tag sees escapes cooked
function cook(strings) { return strings[0] + "|" + strings[1]; }
console.log(cook`p\nq${0}r`);              // cooked: \n -> newline
