// isIMEComposing は isComposing と keyCode 229 のどちらかで変換中とみなすので、片方ずつ撃つ
export const IME_COMPOSING = [
	{ how: "keyCode 229", init: { keyCode: 229 } },
	{ how: "isComposing", init: { isComposing: true } },
];
