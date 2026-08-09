class InvalidEscapedPrivateReference {
  #field;

  read() {
    return this.\u0023field;
  }
}
