function loop() {
  var i = 0;
  var start = new Date().getTime();
  while(true) {
    i++;
    document.body.innerHTML += i + '. Iteration. ' + (new Date().getTime() - start) + 's <br>';
    $gs_sleep(1100);
  }
}
