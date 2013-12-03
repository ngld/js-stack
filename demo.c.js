function loop() {
    var $gsl = 0, $gsg, i, start;
    return function() {
        while (true) switch ($gsl) {
          case 0:
            i = 0;
            ;
            start = new Date().getTime();
            ;

          case 1:
            if (!true) {
                $gsl = 3;
                break;
            }
            i++;
            document.body.innerHTML += i + ". Iteration. " + (new Date().getTime() - start) + "s <br>";
            $gsg = $gs_sleep(1100);
            $gsl = 2;

          case 2:
            if ($gsg() == $gss) return $gss;;
            $gsl = 1;
            break;

          case 3:        }
    };
}