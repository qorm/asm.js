import util from "node:util";
console.log(util.inspect({a:1,b:{c:2}}, {depth: 0}));
console.log(util.inspect({a:1,b:{c:2}}, {depth: 1}));
console.log(util.inspect({a:{b:{c:{d:1}}}}));
console.log(util.inspect([1,[2,[3,[4]]]], {depth: 1}));
console.log(util.isArray([1]), util.isArray("x"));
console.log(util.format("obj: %s", {a:1}));
