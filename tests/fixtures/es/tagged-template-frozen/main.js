"use strict";
var o = null;
(function (s) { o = s; })``;
try { o.x = 1; console.log("no throw"); }
catch (e) { console.log(e.name); }
try { o.raw.y = 1; console.log("raw no throw"); }
catch (e) { console.log("raw " + e.name); }
console.log(o.raw !== undefined);
