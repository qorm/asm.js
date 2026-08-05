try {
    require("./a.js");
} catch (e) {
    console.log("first", e);
}

try {
    require("./a.js");
} catch (e) {
    console.log("second", e);
}

console.log("after");
