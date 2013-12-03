
var $gss = "__$gss_stop_mark__id", $gs_root = null, $_gs_switch_val = null, $_gs_cache;

function $gs_enter(gen) {
    $gs_root = gen;
    $gs_root();
}

function $gs_pause() {
    var switched = false;
    return function () {
        if(switched) {
            var tmp = $_gs_switch_val;
            $_gs_switch_val = null;
            
            return tmp;
        } else {
            switched = true;
            return $gss;
        }
    };
}

function $gs_continue(val) {
    $_gs_switch_val = val;
    $gs_root();
}

function $gs_call(res) {
    if(typeof res == 'function' && res['$gs']) {
        return res;
    } else {
        return function () {return res};
    }
}

// An example function...
function $gs_sleep(millis) {
    // Resume after millis milliseconds
    setTimeout($gs_continue, millis);
    
    // And pause the program for now.
    return $gs_pause();
}
