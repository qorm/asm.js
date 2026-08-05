import("./" + "dep.js").then(function(ns) {
    console.log(ns.answer);
});
