#! /usr/bin/env node
// -*- js -*-

"use strict";

var forced = true;
var whitelist = [];

var UglifyJS = require("./UglifyJS2/tools/node");
//var UglifyJS = require('uglifyjs');
var sys = require("util");
var fs = require("fs");
var reserved = [ 'arguments', 'window', 'document', 'setTimeout', 'setInterval', 'alert', 'print', 'console' ];

function read_whole_file(filename) {
    if (filename == "-") {
        // XXX: this sucks.  How does one read the whole STDIN
        // synchronously?
        filename = "/dev/stdin";
    }
    try {
        return fs.readFileSync(filename, "utf8");
    } catch(ex) {
        sys.error("ERROR: can't read file: " + filename);
        process.exit(1);
    }
}

function dump(item, return_, depth) {
    if(!depth) depth = 0;
    var out;
    
    try {
        out = '// ' + JSON.stringify(item, null, '  ').replace(/\n/g, '\n// ') + '\n';
    } catch(e) {
        var ret = [];
        for (var i in item) {
            var j = item[i];
            if (typeof j === 'string' || typeof j === 'number') {
                ret.push(typeof j + ', ' + i + ': ' + j);
            } else {
                ret.push(typeof j + ', ' + i + ':\n    ' + (depth > 0 ? '[?]' : dump(j, true, depth + 1)));
            }
        }
        out = ret.join(',\n') + '\n\n';
    }
    out = out.replace(/\n/g, '\n    ');
    
    if(return_) {
        return out;
    } else {
        process.stderr.write(out);
    }
}

var active_scope = [];
var cons_idx = 0;
function enter_scope() {
    active_scope.unshift({
        res_count: 0,
        defs: [],
        chunks: [[]],
        chunk_stack: [],
        current: 0,
        break_body: [],
        continue_body: []
    });
}

function leave_scope() {
    active_scope.shift();
}

function enter_part() {
    var sc = active_scope[0];
    sc.chunk_stack.push([sc.chunks, sc.current]);
    sc.chunks = [[]];
    sc.current = 0;
}

function leave_part() {
    var sc = active_scope[0];
    var chunks = sc.chunks;
    
    var pack = sc.chunk_stack.pop();
    sc.chunks = pack[0];
    sc.current = pack[1];
    
    return chunks;
}

function add_js(chunk) {
    if(chunk instanceof UglifyJS.AST_BlockStatement) {
        if(chunk.body == null) return;
        
        chunk.body.forEach(add_js);
        return;
    } else if(chunk instanceof UglifyJS.AST_EmptyStatement) {
        return;
    } else if(chunk instanceof Array) {
        chunk.forEach(add_js);
        return;
    } else if(!(chunk instanceof UglifyJS.AST_Node)) {
        dump('add_js(): What\'s this?');
        dump(chunk);
        return;
    } else if(!(chunk instanceof UglifyJS.AST_Statement)) {
        chunk = new UglifyJS.AST_SimpleStatement({ body: chunk });
    }
    
    var sc = active_scope[0];
    sc.chunks[sc.current].push(chunk);
}

function gen_goto(idx, skip_break) {
    var ass = new UglifyJS.AST_SimpleStatement({
        body: new UglifyJS.AST_Assign({
            left: new UglifyJS.AST_SymbolRef({ name: '$gsl' + active_scope.length }),
            operator: '=',
            right: new UglifyJS.AST_Number({ value: idx })
        })
    });
    
    if(skip_break) {
        return [ass];
    } else {
        return [ass, new UglifyJS.AST_Break()];
    }
}

function set_goto(goto_, idx) {
    goto_[0].body.right.value = idx;
}

function goto_chunk(idx, skip_break) {
    add_js(gen_goto(idx, skip_break));
}

function new_chunk(skip_goto) {
    active_scope[0].chunks.push([]);
    active_scope[0].current++;
}

function add_res_var(tmp) {
    var res_name = '$gs' + active_scope.length + 'r' + active_scope[0].res_count++;
    var def = new UglifyJS.AST_VarDef({ name: new UglifyJS.AST_SymbolRef({ name: res_name }) });
    
    if(tmp) {
        add_js(new UglifyJS.AST_Var({ definitions: [def] }));
    } else {
        active_scope[0].defs.push(def);
    }
    return res_name;
}

function process_chunk(generator, proc) {
    var sc = active_scope[0];
    new_chunk();
    
    var start = sc.current;
    generator();
    
    for(var i = start; i <= sc.current; i++) {
        sc.chunks[i] = sc.chunks[i].map(proc);
    }
}

var change_calls = new UglifyJS.TreeTransformer(function (node, descend) {
    if(node instanceof UglifyJS.AST_Scope && (node.uses_generator || forced)) {
        if(node.name != null && whitelist.indexOf(node.name.name) != -1) {
            node.whitelisted = true;
            node.uses_generator = false;
            return node;
        }
        
        var defs = [
            new UglifyJS.AST_VarDef({
                name: new UglifyJS.AST_SymbolRef({ name: '$gsl' + (active_scope.length + 1) }),
                value: new UglifyJS.AST_Number({ value: 0 })
            }),
            new UglifyJS.AST_VarDef({
                name: new UglifyJS.AST_SymbolRef({ name: '$gsg' + (active_scope.length + 1) })
            })
        ];
        var plain_args = [];
        if(node.argnames != null) {
            plain_args = node.argnames.map(function (arg) {
                return arg.name;
            });
        }
        
        node.variables.each(function (sym) {
            if(!sym.undeclared && reserved.indexOf(sym.name) == -1 && sym.scope == node && plain_args.indexOf(sym.name) == -1) { 
                defs.push(new UglifyJS.AST_VarDef({ name: new UglifyJS.AST_SymbolRef({ name: sym.name }) }));
            }
        });
        
        enter_scope();
        active_scope[0].defs = defs;
        
        for(var i = 0; i < node.body.length; i++) {
            var child = node.body[i];
            var cc = child.transform(change_calls);
            add_js(cc);
        }
        // Make sure the function returns and doesn't loop indefinitely....
        add_js(new UglifyJS.AST_Return());
        
        var body;
        if(active_scope[0].chunks.length > 1) {
            var i = 0;
            var branches = active_scope[0].chunks.map(function (body) {
                return new UglifyJS.AST_Case({
                    expression: new UglifyJS.AST_Number({ value: i++ }),
                    body: body
                });
            });
            
            var generator = new UglifyJS.AST_Lambda({
                argnames: [],
                body: [
                    new UglifyJS.AST_While({
                        condition: new UglifyJS.AST_True(),
                        body: new UglifyJS.AST_Switch({
                            expression: new UglifyJS.AST_SymbolRef({ name: '$gsl' + active_scope.length }),
                            body: branches
                        })
                    })
                ]
            });
            
            if(node instanceof UglifyJS.AST_Toplevel) {
                // This is the top level so call our entry point with the generator as argument...
                
                node.body = [
                    new UglifyJS.AST_Var({ definitions: defs }),
                    new UglifyJS.AST_Call({
                        expression: new UglifyJS.AST_SymbolRef({ name: '$gs_enter' }),
                        args: [ generator ]
                    })
                ];
            } else {
                if(node.name && node.name.name) {
                    var name = node.name.name;
                } else {
                    var name = 'cb';
                }
                generator.name = new UglifyJS.AST_SymbolLambda({ name: name });
                node.body = [
                    new UglifyJS.AST_Var({ definitions: defs }),
                    generator,
                    new UglifyJS.AST_SimpleStatement({
                        body: new UglifyJS.AST_Assign({
                            left: new UglifyJS.AST_SymbolRef({ name: name + '.$gs' }),
                            operator: '=',
                            right: new UglifyJS.AST_True()
                        })
                    }),
                    new UglifyJS.AST_Return({ value: new UglifyJS.AST_SymbolRef({ name: name }) })
                ];
            }
        } else {
            // $gsl* and $gsg* aren't used, don't include them.
            if(defs.length < 3) {
                node.body = active_scope[0].chunks[0];
            } else {
                node.body = [new UglifyJS.AST_Var({ definitions: defs.splice(2) })].concat(active_scope[0].chunks[0]);
            }
        }
        leave_scope();
        
        return node;
    } else if(this.find_parent(UglifyJS.AST_Scope).uses_generator || forced) {
        if(node instanceof UglifyJS.AST_Call && !(node instanceof UglifyJS.AST_New) && ((node.expression instanceof UglifyJS.AST_SymbolRef && node.expression.thedef && node.expression.thedef.is_generator) || (node.expression instanceof UglifyJS.AST_PropAccess) || forced)) {
            if(whitelist.indexOf(node.expression.name) != -1) return;
            
            var res_used = false;
            var insert = false;
            if(typeof node.expression.thedef == 'undefined')
                node.expression.thedef = new Object;
            
            if(node.expression instanceof UglifyJS.AST_Dot) {
                node.expression.expression = node.expression.expression.transform(change_calls);
            }
            
            node.args = UglifyJS.MAP(node.args, function (arg) {
                return arg.transform(change_calls);
            });
            
            // Retrieve our generator...
            var init = new UglifyJS.AST_SimpleStatement({
                body: new UglifyJS.AST_Assign({
                    left: new UglifyJS.AST_SymbolConst({ name: '$gsg' + active_scope.length }),
                    operator: '=',
                    right: node
                })
            });
            
            if(forced && !node.expression.thedef.is_generator || node.expression instanceof UglifyJS.AST_PropAccess) {
                init.body.right = new UglifyJS.AST_Call({
                    expression: new UglifyJS.AST_SymbolRef({ name: '$gs_call' }),
                    args: [node]
                });
            }
            
            // Call the generator.
            var call = new UglifyJS.AST_Call({
                expression: new UglifyJS.AST_SymbolRef({ name: '$gsg' + active_scope.length }),
                args: []
            });
            
            if(this.parent() instanceof UglifyJS.AST_SimpleStatement) {
                var res = null;
                var cond = new UglifyJS.AST_If({
                   condition: new UglifyJS.AST_Binary({
                        left: call,
                        operator: '==',
                        right: new UglifyJS.AST_SymbolRef({ name: '$gss' })
                    }),
                    body: new UglifyJS.AST_Return({
                        value: new UglifyJS.AST_SymbolRef({ name: '$gss' })
                    }) 
                });
                
                add_js(init);
                goto_chunk(active_scope[0].current + 1, true);
                new_chunk();
                
                add_js(cond);
            } else {
                var res_name = add_res_var();
                var res = new UglifyJS.AST_SimpleStatement({
                    body: new UglifyJS.AST_Assign({
                        left: new UglifyJS.AST_SymbolConst({ name: res_name }),
                        operator: '=',
                        right: call
                    })
                });
                
                var cond = new UglifyJS.AST_If({
                    condition: new UglifyJS.AST_Binary({
                        left: new UglifyJS.AST_SymbolRef({ name: res_name }),
                        operator: '==',
                        right: new UglifyJS.AST_SymbolRef({ name: '$gss' })
                    }),
                    body: new UglifyJS.AST_Return({
                        value: new UglifyJS.AST_SymbolRef({ name: '$gss' })
                    })
                });
                
                add_js(init);
                goto_chunk(active_scope[0].current + 1, true);
                new_chunk();
                
                add_js(res);
                add_js(cond);
                return new UglifyJS.AST_SymbolRef({ name: res_name });
            }
        } else if(node instanceof UglifyJS.AST_Var) {
            // We already declared all variables in the first line of our new function.
            // ... but let's see if we should assign values to them.
            
            node.definitions.forEach(function (stm) {
                if(stm.value != null) {
                    add_js(new UglifyJS.AST_SimpleStatement({
                        body: new UglifyJS.AST_Assign({
                            left: new UglifyJS.AST_SymbolRef({ name: stm.name.name }),
                            operator: '=',
                            right: stm.value.transform(change_calls)
                        })
                    }));
                }
            });
        } else if(node instanceof UglifyJS.AST_Break) {
            add_js(new UglifyJS.AST_BlockStatement({
                body: active_scope[0].break_body[0]
            }));
        } else if(node instanceof UglifyJS.AST_Continue) {
            add_js(new UglifyJS.AST_BlockStatement({
                body: active_scope[0].continue_body[0]
            }));
        } else if(node instanceof UglifyJS.AST_Do) {
            new_chunk();
            var start = active_scope[0].current;
            var skip = gen_goto(-1);
            
            active_scope[0].continue_body.unshift(gen_goto(start));
            active_scope[0].break_body.unshift(skip);
            
            add_js(node.body.transform(change_calls));
            
            add_js(new UglifyJS.AST_If({
                condition: node.condition.transform(change_calls),
                body: new UglifyJS.AST_BlockStatement({
                    body: gen_goto(start)
                })
            }));
            
            new_chunk();
            set_goto(skip, active_scope[0].current);
            
            active_scope[0].continue_body.shift();
            active_scope[0].break_body.shift();
        } else if(node instanceof UglifyJS.AST_While) {
            new_chunk();
            
            var start = active_scope[0].current;
            var skip = gen_goto(-1);
            
            active_scope[0].continue_body.unshift(gen_goto(start));
            active_scope[0].break_body.unshift(skip);
            
            add_js(new UglifyJS.AST_If({
                condition: new UglifyJS.AST_UnaryPrefix({
                    operator: '!',
                    expression: node.condition.transform(change_calls)
                }),
                body: new UglifyJS.AST_BlockStatement({ body: skip })
            }));
            
            add_js(node.body.transform(change_calls));
            
            goto_chunk(start);
            new_chunk();
            
            set_goto(skip, active_scope[0].current);
            
            active_scope[0].continue_body.shift();
            active_scope[0].break_body.shift();
        } else if(node instanceof UglifyJS.AST_ForIn) {
            // Generate a list which contains all the keys for(... in ...) iterates over and then use a normal for(...;...;...) loop.
            var keys = add_res_var();
            var idx = add_res_var();
            
            add_js(new UglifyJS.AST_SimpleStatement({
                body: new UglifyJS.AST_Assign({
                    left: new UglifyJS.AST_SymbolRef({ name: keys }),
                    operator: '=',
                    right: new UglifyJS.AST_Array({
                        elements: []
                    })
                })
            }));
            add_js(new UglifyJS.AST_ForIn({
                init: new UglifyJS.AST_Var({
                    definitions: [new UglifyJS.AST_VarDef({
                        name: new UglifyJS.AST_SymbolConst({ name: '$gsi' })
                    })]
                }),
                name: new UglifyJS.AST_SymbolRef({ name: '$gsi' }),
                object: node.object,
                body: new UglifyJS.AST_SimpleStatement({
                    body: new UglifyJS.AST_Call({
                        expression: new UglifyJS.AST_SymbolRef({ name: keys + '.push' }),
                        args: [ new UglifyJS.AST_SymbolRef({ name: '$gsi' }) ]
                    })
                })
            }));
            add_js(new UglifyJS.AST_SimpleStatement({
                body: new UglifyJS.AST_Assign({
                    left: new UglifyJS.AST_SymbolRef({ name: idx }),
                    operator: '=',
                    right: new UglifyJS.AST_Number({ value: 0 })
                })
            }));
            
            new_chunk();
            
            var start = active_scope[0].current;
            var skip = gen_goto(-1);
            
            active_scope[0].continue_body.unshift(gen_goto(start));
            active_scope[0].break_body.unshift(skip);
            
            add_js(new UglifyJS.AST_If({
                condition: new UglifyJS.AST_Binary({
                    left: new UglifyJS.AST_SymbolRef({ name: idx }),
                    operator: '==',
                    right: new UglifyJS.AST_SymbolRef({ name: keys + '.length' })
                }),
                body: new UglifyJS.AST_BlockStatement({ body: skip })
            }));
            
            add_js(new UglifyJS.AST_SimpleStatement({
                body: new UglifyJS.AST_Assign({
                    left: node.name || node.init,
                    operator: '=',
                    right: new UglifyJS.AST_SymbolRef({ name: keys + '[' + idx + ']' })
                })
            }));
            add_js(node.body.transform(change_calls));
            
            add_js(new UglifyJS.AST_SimpleStatement({
                body: new UglifyJS.AST_UnaryPostfix({
                    expression: new UglifyJS.AST_SymbolRef({ name: idx }),
                    operator: '++'
                })
            }));
            goto_chunk(start);
            new_chunk(true);
            
            set_goto(skip, active_scope[0].current);
            
            active_scope[0].continue_body.shift();
            active_scope[0].break_body.shift();
        } else if(node instanceof UglifyJS.AST_For) {
            if(node.init != null) add_js(new UglifyJS.AST_SimpleStatement({ body: node.init.transform(change_calls) }));
            new_chunk();
            
            var start = active_scope[0].current;
            var skip = gen_goto(-1);
            
            active_scope[0].continue_body.unshift(gen_goto(start));
            active_scope[0].break_body.unshift(skip);
            
            if(node.condition != null) {
                add_js(new UglifyJS.AST_If({
                    condition: new UglifyJS.AST_UnaryPrefix({
                        operator: '!',
                        expression: node.condition.transform(change_calls)
                    }),
                    body: new UglifyJS.AST_BlockStatement({ body: skip })
                }));
            }
            
            add_js(node.body.transform(change_calls));
            
            if(node.step != null) {
                add_js(new UglifyJS.AST_SimpleStatement({
                        body: node.step.transform(change_calls)
                }));
            }
            goto_chunk(start);
            new_chunk(true);
            
            set_goto(skip, active_scope[0].current);
            
            active_scope[0].continue_body.shift();
            active_scope[0].break_body.shift();
        } else if(node instanceof UglifyJS.AST_With) {
            // TODO: Doesn't work if anything comes after the with() statement...
            UglifyJS.AST_Node.warn("{msg} [{file}:{line},{col}]", {
                msg: 'with() statement found! Isn\'t completely supported yet... Please avoid it!',
                file: node.start.file,
                line: node.start.line,
                col: node.start.col
            });
            
            new_chunk();
            var cur_chunk = active_scope[0].current;
            
            add_js(node.body.transform(change_calls));
            
            var block = node.clone();
            block.body = new UglifyJS.AST_BlockStatement({
                body: []
            });
            
            // Wrap all chunks created by the block's body in a clone of the with() statement.
            for(var i = cur_chunk; i <= active_scope[0].current; i++) {
                var nblock = block.clone();
                nblock.body = nblock.body.clone();
                nblock.body.body = active_scope[0].chunks[i];
                
                active_scope[0].chunks[i] = [nblock];
            }
        } else if(node instanceof UglifyJS.AST_If) {
            var skip = gen_goto(-1);
            
            var rep = new UglifyJS.AST_If({
                condition: new UglifyJS.AST_UnaryPrefix({
                    operator: '!',
                    expression: node.condition.transform(change_calls)
                }),
                body: new UglifyJS.AST_BlockStatement({
                    body: skip
                })
            });
            
            add_js(rep);
            add_js(node.body.transform(change_calls));
            
            if(node.alternative != null) {
                var pos_end = gen_goto(-1);
                add_js(pos_end);
                
                new_chunk(true);
                set_goto(skip, active_scope[0].current);
                
                add_js(node.alternative.transform(change_calls));
                
                new_chunk();
                set_goto(pos_end, active_scope[0].current);
            } else {
                new_chunk();
                
                set_goto(skip, active_scope[0].current);
            }
        } else if(node instanceof UglifyJS.AST_Switch) {
            var hub_pos = active_scope[0].current;
            var hub_map = [];
            var default_pos = null;
            var skip_body = [];
            var res_name;
            var skip = gen_goto(-1);
            
            active_scope[0].break_body.unshift(skip);
            
            if(node.expression instanceof UglifyJS.AST_SymbolRef) {
                res_name = node.expression.name;
            } else {
                res_name = add_res_var(true);
                add_js(new UglifyJS.AST_SimpleStatement({
                    body: new UglifyJS.AST_Assign({
                        left: new UglifyJS.AST_SymbolRef({ name: res_name }),
                        operator: '=',
                        right: node.expression.transform(change_calls)
                    })
                }));
            }
            
            node.body.forEach(function (stm) {
                new_chunk(true);
                if(stm instanceof UglifyJS.AST_Case) {
                    hub_map.push([stm.expression, active_scope[0].current]);
                } else {
                    default_pos = active_scope[0].current;
                }
                
                stm.body.forEach(function (stm) {
                    add_js(stm.transform(change_calls));
                });
            });
            
            new_chunk();
            var end_pos = active_scope[0].current;
            active_scope[0].current = hub_pos;
            
            hub_map.forEach(function (branch) {
                add_js(new UglifyJS.AST_If({
                    condition: new UglifyJS.AST_Binary({
                        left: new UglifyJS.AST_SymbolRef({ name: res_name }),
                        operator: '==',
                        right: branch[0].transform(change_calls)
                    }),
                    body: new UglifyJS.AST_BlockStatement({ body: gen_goto(branch[1]) })
                }));
            });
            
            goto_chunk(default_pos == null ? end_pos : default_pos);
            
            set_goto(skip, end_pos);
            active_scope[0].current = end_pos;
            active_scope[0].break_body.shift();
        } else if(node instanceof UglifyJS.AST_Try) {
            var bcatch = null, gcatch = gen_goto(-1);
            var gfinally = gen_goto(-1);
            
            if(node.bcatch != null) {
                if(node.bcatch.body.length == 0) {
                    bcatch = new UglifyJS.AST_Catch({
                        argname: new UglifyJS.AST_SymbolRef({ name: '$gse' }),
                        body: []
                    });
                } else {
                    bcatch = new UglifyJS.AST_Catch({
                        argname: new UglifyJS.AST_SymbolRef({ name: '$gse' }),
                        body: [
                            new UglifyJS.AST_Assign({
                                left: node.bcatch.argname,
                                operator: '=',
                                right: new UglifyJS.AST_SymbolRef({ name: '$gse' })
                            })
                        ].concat(gcatch)
                    });
                }
            }
            
            if(node.bfinally != null && node.bfinally.body.length == 0) {
                node.bfinally = null;
            }
            
            if(node.bfinally != null && node.bcatch == null) {
                bcatch = new UglifyJS.AST_Catch({
                    argname: new UglifyJS.AST_SymbolRef({ name: '$gse' }),
                    body: gfinally
                });
            }
            
            new_chunk()
            var start = active_scope[0].current;
            
            node.body.forEach(function (body) {
                add_js(body.transform(change_calls));
            });
            
            for(var i = start; i <= active_scope[0].current; i++) {
                active_scope[0].chunks[i] = [ new UglifyJS.AST_Try({
                    body: active_scope[0].chunks[i],
                    bcatch: bcatch
                }) ];
            }
            
            if(node.bcatch != null) {
                add_js(gfinally);
                
                new_chunk();
                set_goto(gcatch, active_scope[0].current);
                
                node.bcatch.body.forEach(function (body) {
                    add_js(body.transform(change_calls));
                });
                
                new_chunk();
                set_goto(gfinally, active_scope[0].current);
            }
            
            if(node.bfinally != null) {
                add_js(node.bfinally.body);
            }
        } else {
            return;
        }
        
        return new UglifyJS.AST_EmptyStatement();
    }
}, function (node, in_list) {
    if(in_list && this.parent() instanceof UglifyJS.AST_Statement && !(this.parent() instanceof UglifyJS.AST_Try || this.parent() instanceof UglifyJS.AST_Catch || this.parent() instanceof UglifyJS.AST_Finally)) {
        add_js(node);
        return new UglifyJS.AST_EmptyStatement();
    }
});

var files = process.argv.splice(2);
var top = null;
var arg_count = 0;
for(var i = 0; i < files.length; i++) {
    if(files[i][0] != '-')
        break;
    
    switch(files[i]) {
        case '--trace':
        case '-t':
            forced = false;
            break;
        case '--whitelist':
        case '-w':
            i++;
            whitelist = files[i].split(',');
            break;
        default:
            process.stderr.write('ERROR: Unknown argument "' + files[i] + '"!\n');
            process.exit(1);
    }
    
    arg_count = i + 1;
}

// Cut off the arguments
files = files.splice(arg_count);
if(files.length == 0) {
    process.stderr.write('Usage: node rewriter.js test1.js test2.js ...\n');
    process.exit(0);
}

for(var i = 0; i < files.length; i++) {
    process.stderr.write('Reading ' + files[i] + '...\n');
    
    top = UglifyJS.parse(read_whole_file(files[i]), {
        filename: files[i],
        toplevel: top
    });
}

var out = new UglifyJS.OutputStream({ beautify: true });

top.figure_out_scope();
//top.scope_warnings();
if(top.globals.has('$gs_enter')) {
    top.globals.get('$gs_enter').references.forEach(function (self) {
        self.scope.is_entry = true;
    });
}

top.globals.each(function (sym, name) {
    function mark(sym) {
        sym.is_generator = true;
        sym.references.forEach(function (self) {
            if(self.scope.is_entry) return;
            
            self.scope.uses_generator = true;
            if(self.scope.name) {
                mark(self.scope.find_variable(self.scope.name));
            }
        });
    }
    
    if(name.substring(0, 4) == '$gs_') {
        mark(sym);
    }
});

process.stderr.write('Rewriting...\n');
top.transform(change_calls);
top.print(out);

sys.print(out.get());
