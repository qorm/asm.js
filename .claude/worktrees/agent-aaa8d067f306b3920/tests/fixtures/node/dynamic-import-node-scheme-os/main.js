import("node:os").then(function(ns) {
    print(ns.platform());
    print(typeof ns.default);
});
