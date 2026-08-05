function check(re, s) { return re.test(s); }
function ex(re, s) { return re.exec(s); }
const r = /(e)(l+)/;
console.log(check(r, "hello"));
console.log(check(/xyz/, "hello"));
console.log(check(new RegExp("l+"), "hello"));
const m = ex(r, "hello");
console.log(m ? m[0] + "|" + m[1] + "|" + m[2] : "null");
const obj = { test(x){ return "user:" + x; } };
function callTest(o){ return o.test("Z"); }
console.log(callTest(obj));
