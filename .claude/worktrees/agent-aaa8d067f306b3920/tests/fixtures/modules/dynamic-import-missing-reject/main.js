console.log("before");
import("./missing.js").catch(function(err) {
    console.log(String(err));
});
console.log("after");
