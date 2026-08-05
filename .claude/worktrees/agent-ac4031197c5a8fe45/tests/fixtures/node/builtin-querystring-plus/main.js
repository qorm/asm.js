import qs from "node:querystring";
console.log(qs.unescape("100%25+sure"));
console.log(qs.unescape("a+b"));
console.log(JSON.stringify(qs.parse("a=b+c")));
console.log(JSON.stringify(qs.parse("x=%20y")));
console.log(qs.unescape("%E2%9C%93"));
console.log(qs.escape("a b+c"));
