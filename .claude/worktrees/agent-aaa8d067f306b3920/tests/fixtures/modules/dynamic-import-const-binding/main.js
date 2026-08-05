const target = "./dep.js";

import(target).then(function(ns) {
    console.log(ns.answer);
});
