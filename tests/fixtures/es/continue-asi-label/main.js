var j;
FOR1 : for(var i=1;i<2;i++){
  FOR1NESTED : for(j=1;j<2;j++) {
    continue
FOR1;
  }
}
console.log(j);
