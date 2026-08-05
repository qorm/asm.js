{
    let ok = 1;
    console.log(ok);
}
console.log("before");
{
    console.log(x);
    let x = 5;
    console.log("unreached");
}
