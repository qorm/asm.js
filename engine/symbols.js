// 引擎片段可引用的运行时符号有序表(单一真源)。
// 片段 reloc 用下标作 symId;**只能在末尾追加,不可重排/删除**——
// engine/compile.js 的 SYM_IDS 与 runtime/core/allocator.js 的 _engine_symaddr
// 分派表都由本表派生,顺序即 ABI。
export const SYM_NAMES = [
    "_number_coerce", "_js_add", "_valueToStr", "_strconcat",
    "_object_get_ic", "_subscript_get", "_math_sqrt", "_js_band",
    "_js_bor", "_js_bxor", "_js_bshl", "_js_bshr",
    "_js_bushr", "_to_boolean", "_js_relcmp", "_math_abs",
    "_math_floor", "_math_ceil", "_math_round", "_math_pow",
    "_heap_base", "_heap_ptr", "_abstract_eq", "_floatToString",
    "_array_new_with_size", "_array_set", "_object_new_sized", "_object_define",
    "_js_length", "_js_box_string", "_js_typeof", "_array_join",
    "_array_to_string", "_str_toUpperCase", "_str_toLowerCase", "_str_slice",
    "_str_indexOf", "_str_charCodeAt", "_str_split", "_str_trim",
    "_str_substring", "_str_repeat", "_str_includes", "_str_replace",
    "_js_unbox", "_array_length", "_getStrContent", "_typeof",
    "_to_int32", "_object_get", "_maybe_getter", "_js_lt",
    "_js_le", "_js_gt", "_js_ge", "_math_trunc",
    "_math_cbrt", "_str_padStart", "_str_padEnd", "_str_at",
    "_str_charAt", "_str_startsWith", "_str_endsWith", "_str_replaceAll",
    "_str_replaceAll_fn", "_array_push", "_array_get", "_array_reverse",
    "_array_slice", "_array_includes", "_array_indexOf", "_array_at",
    "_array_flat", "_math_log", "_math_log2", "_math_log10",
    "_math_exp", "_throw_unwind", "_js_parseInt", "_js_parseFloat",
    "_str_to_num", "_is_bigint", "_num_toFixed", "_strcmp",
    "_str_lastIndexOf", "_instanceof", "_num_toString", "_subscript_set",
    "_exception_value", "_exception_pending", "_typed_array_new", "_alloc",
    "_coroutine_create", "_strict_eq", "_syscall_arg", "_promise_new",
    "_scheduler_spawn", "_box_alloc", "_print_str", "_exc_ctx_top",
    "_str_codepoint_at", "_object_new", "_object_set", "_str_cp_bytes",
    "_map_entries", "_tag_str_a1", "_tag_key_a1", "_validate_callable",
    "_array_pop", "_array_shift", "_array_unshift", "_array_splice",
    "_array_concat", "_box_arr_r", "_iterator_close", "_box_obj_r",
    "_object_normalize_order", "_intToStr", "_is_symbol", "_array_spread_into",
    "_array_species_check", "_agen_map", "_agen_filter", "_agen_splice",
    "_array_splice_rt", "_call_argc", "_closure_props_find", "_object_has",
    "_nan_canon", "_generator_new", "_closure_prop_set", "_object_set_prop_attr",
    "_global_this", "_func_meta_strict", "_array_spread_into_n", "_js_box_function",
    "_closure_prop_get", "_closure_prop_define", "_closure_prop_set_attr", "_symbol_wellknown",
    "_object_new_raw", "_object_delete", "_throw_reference_error", "_private_brand_check",
    "_accessor_define", "_error_opt_has_cause", "_error_msg_norm", "_Promise_all",
    "_Promise_allSettled", "_Promise_any", "_Promise_race", "_Promise_reject",
    "_Promise_resolve", "_Promise_withResolvers", "_agen_concat", "_agen_pop",
    "_agen_slice", "_agen_sort", "_agen_splice_items", "_aref_arr_indexOf",
    "_aref_num_toFixed", "_aref_obj_hasOwn", "_aref_relidx", "_aref_require_cb",
    "_array_filter_rt_t", "_array_flatMap_rt", "_array_flat_rt", "_array_iterator_new",
    "_array_lastIndexOf", "_array_like_copy", "_array_map_rt_t", "_array_new_undefined",
    "_array_reduceRight_rt", "_array_reduce_rt", "_array_setlength_throw", "_array_sort",
    "_array_sort_cmp", "_array_spread_into_map", "_array_toSpliced", "_array_with",
    "_arraybuffer_bytelength", "_arraybuffer_new", "_arraybuffer_slice", "_bigint_box",
    "_bigint_cmp", "_bigint_neg", "_bigint_strict_eq", "_boolean_new",
    "_builtin_boolean", "_builtin_string", "_cjs_require_lazy", "_closure_prop_tombstoned",
    "_collection_mark_weak", "_concat_append_item", "_coroutine_yield", "_cstr_to_heap_str",
    "_dataview_get", "_dataview_new", "_dataview_set", "_date_getTime",
    "_date_get_part_num", "_date_new", "_date_new_from_string", "_date_new_ts",
    "_date_now", "_date_parse_iso", "_date_set_part", "_date_set_parts",
    "_date_set_time_f64", "_date_toISOString", "_date_toString", "_engine_exec",
    "_engine_reloc_exec", "_engine_reloc_exec_fp", "_engine_smoke_exec", "_error_to_str",
    "_ev_run", "_fn_construct_call", "_func_meta_entry", "_func_meta_init",
    "_generator_make_result", "_get_ctor_proto", "_get_module_export", "_heap_init",
    "_instanceof_proto", "_is_asmjs_err", "_is_promise", "_is_promise_or_thenable",
    "_js_length_dyn", "_js_prop_key", "_js_set_length", "_m_bringup_smoke",
    "_main", "_map_clear", "_map_delete", "_map_get",
    "_map_groupBy", "_map_has", "_map_keys", "_map_new",
    "_map_set", "_map_values", "_math_atan2", "_numberToString",
    "_number_new", "_object_assign", "_object_create", "_object_defineProperty_proxy",
    "_object_define_properties_recv_check", "_object_define_property", "_object_define_property_dyn", "_object_entries",
    "_object_getOwnPropertyDescriptor", "_object_getOwnPropertySymbols", "_object_groupBy", "_object_propertyIsEnumerable",
    "_object_proto_toLocaleString", "_object_proto_toString", "_object_rest", "_object_setPrototypeOf",
    "_object_set_attr", "_object_set_ic", "_object_values", "_par_alloc_smoke",
    "_par_gc_smoke", "_par_smoke", "_par_stw_smoke", "_print_bool",
    "_print_bool_no_nl", "_print_int", "_print_nl", "_print_space",
    "_print_str_no_nl", "_print_value", "_print_value_no_nl", "_process_init",
    "_promise_await", "_promise_catch", "_promise_drain_reactions", "_promise_finally",
    "_promise_invoke1", "_promise_reject", "_promise_resolve", "_promise_then",
    "_promise_then2", "_prop_in", "_proxy_construct_call", "_proxy_new",
    "_scheduler_init", "_scheduler_run", "_set_add", "_set_clear",
    "_set_coerce_arg", "_set_delete", "_set_entries", "_set_has",
    "_set_new", "_set_values", "_str_concat_ip", "_str_index_char",
    "_str_localeCompare", "_str_match", "_str_matchAll", "_str_proto_codePointAt",
    "_str_search", "_str_substr", "_str_trimEnd", "_str_trimStart",
    "_string_new", "_strlen", "_subscript_key_int", "_symbol_new",
    "_symbol_to_string", "_syscall_ptr", "_ta_at", "_ta_buffer",
    "_ta_byteoffset", "_ta_construct", "_ta_copywithin", "_ta_fill",
    "_ta_getprototypeof", "_ta_includes", "_ta_indexof", "_ta_join",
    "_ta_lastindexof", "_ta_need_fn", "_ta_reverse", "_ta_set",
    "_ta_slice", "_ta_sort_cmp", "_ta_to_array", "_tam_find_core",
    "_thread_create_raw", "_thread_join", "_throw_not_a_function", "_throw_type_error",
    "_to_bigint", "_try_hasinstance", "_typed_array_from", "_typed_array_length",
    "_typed_array_set", "_typed_array_view", "_win_build_argv",
    // 取地址(lea)引用的运行时代码标签:闭包/构造器 trampoline、内建函数值体。
    // 片段里当函数指针存进闭包对象,故也要能按 symId 拿宿主地址。
    "_aref_generic", "_aref_static_tramp", "_bound_tramp", "_builtin_number",
    "_date_call", "_fp_throw_accessor", "_object_ctor_call", "_print_wrapper",
    "_spawn_tramp", "_ta_ctor_tramp", "_thread_smoke_child",
    // resizable ArrayBuffer(末尾追加)
    "_arraybuffer_maxbytelength_prop", "_ta_track_add", "_ta_track_update",
    "_ta_elem_size_of_type", "_ta_bytelength_prop",
    "_ab_maxbytelength_prop_dyn", "_ab_resizable_prop_dyn", "_ta_track_div",
    "_ta_link_ctor",
    // ArrayBuffer detach(末尾追加)
    "_arraybuffer_detach", "_ta_is_detached", "_tam_throw_if_detached",
    "_ta_throw_detached", "_ta_is_oob",
    // TypedArray [[DefineOwnProperty]] / Reflect.defineProperty(末尾追加)
    "_object_define_own", "_object_define_own_dyn",
    // TypedArray map/filter species(末尾追加)
    "_tam_map", "_tam_filter",
    // ArraySpeciesCreate / CreateDataPropertyOrThrow(末尾追加)
    "_array_species_create", "_array_cdp_or_throw", "_concat_append_cdp",
    // Array.flat depth ToIntegerOrInfinity(末尾追加)
    "_flat_to_depth",
    // Array.from/of Construct(this) + mapfn 两实参(末尾追加)
    "_array_from_apply_map", "_array_construct_c", "_array_from_iter_into",
    "_is_array_value", "_agen_toLocaleString",
    // Proxy.revocable(末尾追加)
    "_proxy_revocable", "_proxy_revoke", "_proxy_revoke_tramp",
    // TypedArray 活读回调(末尾追加)
    "_ta_forEach", "_ta_every", "_ta_some",
    // TypedArray reduce/with 活读(末尾追加)
    "_ta_reduce", "_ta_reduceRight", "_ta_with",
    // TypedArray slice/same-type/iterator(末尾追加)
    "_ta_create_same_type_len", "_ta_clone_same_type",
    "_ta_iterator_new", "_ta_iterator_next",
    // for-in 原型链键表(末尾追加)
    "_object_forin_keys",
    "_object_all_own_keys",
    "_proxy_ownkeys_validate",
    // Arguments [[ParameterMap]](末尾追加)
    "_args_param_map_install",
    "_args_param_map_get_box",
    "_args_param_map_after_define",
    "_args_param_map_unmap",
    // well-known Symbol 单例槽(.data qword,SymbolGenerator.generateDataSlots 发射)。
    // 片段里 `lea A0,_symwk_X` 取的是**宿主槽地址**(_symbol_wellknown 读/写它),故必须
    // 走运行时重定位、不可内联片段副本 —— 否则 eval 里的 `Symbol.unscopables`/`with`
    // 语句编译失败(未知 adrp 标签),或拿到与宿主不同的符号身份。
    "_symwk_iterator", "_symwk_asyncIterator", "_symwk_hasInstance",
    "_symwk_isConcatSpreadable", "_symwk_match", "_symwk_matchAll",
    "_symwk_replace", "_symwk_search", "_symwk_species", "_symwk_split",
    "_symwk_toPrimitive", "_symwk_toStringTag", "_symwk_unscopables",
    "_promise_await_job",
    // Promise.prototype.then SpeciesConstructor + NewPromiseCapability(末尾追加)
    "_promise_then_spec", "_promise_species_ctor", "_promise_perform_then_cap",
    "_pcap_make_handler", "_promise_super_init",
    // Promise.try(ES2025,末尾追加)
    "_Promise_try",
    // `p.then` 属性读快路的分派入口 + Promise.prototype.catch 的 Invoke 形态
    "_promise_then_dispatch", "_promise_catch_invoke", "_pss_custom_c",
    // IsConstructor(函数元数据 kind bit9)——`class C extends (()=>{})` 的 TypeError
    "_func_meta_nonctor", "_is_nonctor_fn",
    // 寄存器窗口外实参(索引 >= 5)的溢出槽(.data,16 qword;末尾追加)+ spread 调用点填充器
    "_call_argv", "_call_argv_fill",
    "_generator_set_instance_proto",
    "_subscript_set_strict",
    // Function.prototype / Error.prototype.toString(末尾追加;片段 adrp 须能解析)
    "_fp_toString", "_fp_call_tramp", "_fp_apply_tramp", "_fp_bind_tramp",
    "_error_proto_toString", "_fnctor_nop",
    // 片段字符串字面量出线打 STRING_TAG(literals.js → _tag_str_r)
    "_tag_str_r",
    // TA 子类实例原型侧表(末尾追加;class extends Uint8Array 的 super()/instanceof)
    "_ta_bind_instance_proto", "_ta_lookup_instance_proto",
];

// 表中**不是代码标签**的名字:.data 段全局槽(数据段在 _engine_symaddr 生成之后才发射)
// 与最后才发射的 _main。_engine_symaddr 用"已发射 label 表"判平台条件符号是否存在,
// 这些名字那时必然缺席,需在此登记为"确实存在",否则其 id 会被跳过 → 片段取地址得 0
// (如 `eval("x")` 读 _global_this → ldr [0] → SIGSEGV)。
export const SYM_LATE_LABELS = new Set([
    "_heap_base", "_heap_ptr", "_exception_value", "_exception_pending",
    "_exc_ctx_top", "_call_argc", "_call_argv", "_global_this",
    "_func_meta_strict", "_func_meta_entry", "_func_meta_init", "_main",
    "_symwk_iterator", "_symwk_asyncIterator", "_symwk_hasInstance",
    "_symwk_isConcatSpreadable", "_symwk_match", "_symwk_matchAll",
    "_symwk_replace", "_symwk_search", "_symwk_species", "_symwk_split",
    "_symwk_toPrimitive", "_symwk_toStringTag", "_symwk_unscopables",
]);
