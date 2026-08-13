// replaceAll with function replacer (single char match)
var r2 = "40036".replaceAll("0", function(m) { return "Leo"; });
console.log(r2);

// replaceAll with function replacer - ToString on repl value
var r3 = "undefined".replaceAll("e", function(m) { return undefined; });
console.log(r3);
