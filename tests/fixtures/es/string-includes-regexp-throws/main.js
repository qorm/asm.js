"use strict";
try {
  "".includes(/./);
  console.log("includes-no-throw");
} catch (e) {
  console.log("includes=" + e.name);
}
try {
  "".startsWith(/./);
  console.log("startsWith-no-throw");
} catch (e) {
  console.log("startsWith=" + e.name);
}
try {
  "".endsWith(/./);
  console.log("endsWith-no-throw");
} catch (e) {
  console.log("endsWith=" + e.name);
}
try {
  "".includes(new RegExp("."));
  console.log("boxed-no-throw");
} catch (e) {
  console.log("boxed=" + e.name);
}
