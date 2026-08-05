console.log(/(?i:HELLO)/.test("hello"));
console.log(/a(?i:b)c/.test("aBc"), /a(?i:b)c/.test("ABC"));
console.log(/(?i:a)(?-i:b)/.test("Ab"), /(?i:a)(?-i:b)/.test("AB"));
console.log(/(?s:.)/.test("\n"), /./.test("\n"));
console.log(/abc/.test("ABC"), /abc/i.test("ABC"));
console.log("X".match(/(?i:x)/)[0]);
