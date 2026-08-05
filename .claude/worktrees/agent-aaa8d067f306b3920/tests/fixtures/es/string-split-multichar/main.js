// multi-char separators must match the whole separator (not just first char)
console.log("a\r\nb\r\nc".split("\r\n").join("|"));   // a|b|c
console.log("a::b::c".split("::").join("|"));          // a|b|c
console.log("aaa".split("aa").join("|"));              // |a
console.log("a::".split("::").length);                 // 2
console.log("no".split("_").join("|"));                // no
console.log("hello".split("").join("|"));              // h|e|l|l|o
console.log("a_b_c".split("_").join("|"));             // a|b|c (single-char unaffected)
