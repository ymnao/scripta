/**
 * IME（入力メソッド）コンポジション中のキーイベントかどうかを判定する。
 *
 * compositionend が keydown より先に発火するブラウザでは
 * isComposing だけでは判定できない。keyCode 229（IME 処理済み）との
 * 二重チェックで全ブラウザに対応する。
 *
 * @see https://developer.mozilla.org/en-US/docs/Web/API/Element/keydown_event
 */
export function isIMEComposing(e: React.KeyboardEvent | KeyboardEvent): boolean {
	const native = "nativeEvent" in e ? e.nativeEvent : e;
	return native.isComposing || native.keyCode === 229;
}
