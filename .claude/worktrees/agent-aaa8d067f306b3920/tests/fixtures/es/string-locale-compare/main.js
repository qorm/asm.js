console.log("a".localeCompare("b"));
console.log("b".localeCompare("a"));
console.log("a".localeCompare("a"));
console.log("apple".localeCompare("banana"));
console.log("cat".localeCompare("car"));
console.log("abc".localeCompare("ab"));
console.log(["banana", "apple", "cherry"].sort((a, b) => a.localeCompare(b)).join(","));
