Promise.race([Promise.reject("bad"), Promise.resolve(9)]).catch(function(reason) {
    console.log(reason);
});
