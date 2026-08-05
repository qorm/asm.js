function leftpadLike(value, width, fill) {
    let result = value;
    while (result.length < width) {
        result = fill + result;
    }
    return result;
}

function add(a, b) {
    return a + b;
}

console.log(leftpadLike("x", 3, "0"));
console.log(add(1, 2));
