var s = new String("ABCABC");
s.valueOf = function() { return "ed"; };
s.toString = function() { return "ed"; };
console.log(s == "ed");
console.log(s + "");
console.log(s.valueOf());
console.log(new String("1") + undefined);
console.log(new Number(1) == 1);
console.log(new Number(1) + "");
