function FACTORY(){
   this.id = func();
   function func(){ return "id_string"; }
}
var obj = new FACTORY();
console.log(obj.id);
