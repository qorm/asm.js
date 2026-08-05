Promise.all([Promise.resolve(1), Promise.reject("boom")]).catch(function(reason) {
    console.log(reason);
});
