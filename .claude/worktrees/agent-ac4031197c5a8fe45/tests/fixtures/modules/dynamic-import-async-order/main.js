console.log("sync");
import("./mod.js").then(function(ns) {
    console.log("loaded");
    console.log(ns.value);
});
console.log("after");
