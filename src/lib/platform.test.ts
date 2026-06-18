import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * `src/lib/platform.ts` の定数は module-level で `navigator.platform` を読むため、
 * OS 別の値を検証するには `navigator.platform` を書き換えた上で
 * `vi.resetModules()` → dynamic `import("./platform")` で再評価する必要がある。
 *
 * 主目的は #181 で発生した `${SHIFT_KEY_LABEL}${PRIMARY_MOD_SYMBOL}X` 連結の
 * `ShiftCtrl+X` (`+` 欠落) バグ再発防止。新規 `SHIFT_MOD_SYMBOL` 経由なら
 * Mac/Win とも区切り破綻なく連結できることを確認する。
 *
 * jsdom 既定の `navigator.platform = ""` は `afterEach` で復元し、他テストに
 * 影響を残さない。
 */

/**
 * `Object.defineProperty(navigator, "platform", ...)` で値を上書きした後、
 * 元の property descriptor を復元することで他テストへの leak を防ぐ。
 *
 * jsdom 環境では `navigator.platform` は通常 `Navigator.prototype` 上の getter として
 * 定義されており、navigator instance 自身には own property が無い (= `undefined`)。
 * その場合は `Reflect.deleteProperty` で instance 上の上書き定義を削除し、
 * prototype 経由の元の getter を再露出させる。
 *
 * instance に own property があった場合 (将来 jsdom 仕様が変わった場合) はその
 * descriptor を `Object.defineProperty` で書き戻す。`navigator.platform` の直接
 * 参照は `no-navigator-platform` biome plugin で禁止されているため、descriptor 経由で
 * 読む。
 */
const ORIGINAL_PLATFORM_DESCRIPTOR = Object.getOwnPropertyDescriptor(navigator, "platform");

async function importPlatformWith(platformValue: string) {
	Object.defineProperty(navigator, "platform", {
		value: platformValue,
		configurable: true,
	});
	vi.resetModules();
	return await import("./platform");
}

afterEach(() => {
	vi.resetModules();
	if (ORIGINAL_PLATFORM_DESCRIPTOR) {
		Object.defineProperty(navigator, "platform", ORIGINAL_PLATFORM_DESCRIPTOR);
	} else {
		Reflect.deleteProperty(navigator, "platform");
	}
});

describe("OS 判定フラグ", () => {
	it("Mac (MacIntel) は IS_MAC=true / IS_WINDOWS=false", async () => {
		const { IS_MAC, IS_WINDOWS } = await importPlatformWith("MacIntel");
		expect(IS_MAC).toBe(true);
		expect(IS_WINDOWS).toBe(false);
	});

	it("Windows (Win32) は IS_MAC=false / IS_WINDOWS=true", async () => {
		const { IS_MAC, IS_WINDOWS } = await importPlatformWith("Win32");
		expect(IS_MAC).toBe(false);
		expect(IS_WINDOWS).toBe(true);
	});

	it("jsdom 既定の空文字は両フラグ false（非 Mac 扱い）", async () => {
		const { IS_MAC, IS_WINDOWS } = await importPlatformWith("");
		expect(IS_MAC).toBe(false);
		expect(IS_WINDOWS).toBe(false);
	});
});

describe("PRIMARY_MOD_SYMBOL（連結用 primary modifier）", () => {
	it("Mac は `⌘`、後続キーと直結して `⌘V` 形式になる", async () => {
		const { PRIMARY_MOD_SYMBOL } = await importPlatformWith("MacIntel");
		expect(PRIMARY_MOD_SYMBOL).toBe("⌘");
		expect(`${PRIMARY_MOD_SYMBOL}V`).toBe("⌘V");
	});

	it("Windows は `Ctrl+`、後続キーと直結して `Ctrl+V` 形式になる", async () => {
		const { PRIMARY_MOD_SYMBOL } = await importPlatformWith("Win32");
		expect(PRIMARY_MOD_SYMBOL).toBe("Ctrl+");
		expect(`${PRIMARY_MOD_SYMBOL}V`).toBe("Ctrl+V");
	});
});

describe("SHIFT_MOD_SYMBOL（連結用 Shift + primary modifier、#181 連結バグ回帰防止）", () => {
	it("Mac は `⇧⌘`、後続キーと直結して `⇧⌘X` 形式になる", async () => {
		const { SHIFT_MOD_SYMBOL } = await importPlatformWith("MacIntel");
		expect(SHIFT_MOD_SYMBOL).toBe("⇧⌘");
		expect(`${SHIFT_MOD_SYMBOL}X`).toBe("⇧⌘X");
		expect(`${SHIFT_MOD_SYMBOL}T`).toBe("⇧⌘T");
	});

	it("Windows は `Ctrl+Shift+`、後続キーと直結して `Ctrl+Shift+X` 形式になる（順序通り・区切り欠落なし）", async () => {
		const { SHIFT_MOD_SYMBOL } = await importPlatformWith("Win32");
		expect(SHIFT_MOD_SYMBOL).toBe("Ctrl+Shift+");
		expect(`${SHIFT_MOD_SYMBOL}X`).toBe("Ctrl+Shift+X");
		expect(`${SHIFT_MOD_SYMBOL}T`).toBe("Ctrl+Shift+T");
	});

	it("Windows で `Shift+Ctrl+X`（順序逆）や `ShiftCtrl+X`（+ 欠落）にならない", async () => {
		const { SHIFT_MOD_SYMBOL } = await importPlatformWith("Win32");
		const combined = `${SHIFT_MOD_SYMBOL}X`;
		expect(combined).not.toBe("Shift+Ctrl+X");
		expect(combined).not.toBe("ShiftCtrl+X");
	});
});

describe("Kbd チップ表示用ラベル", () => {
	it("Mac は modifier=⌘ / shift=⇧", async () => {
		const { MOD_KEY_LABEL, SHIFT_KEY_LABEL } = await importPlatformWith("MacIntel");
		expect(MOD_KEY_LABEL).toBe("⌘");
		expect(SHIFT_KEY_LABEL).toBe("⇧");
	});

	it("Windows は modifier=Ctrl / shift=Shift", async () => {
		const { MOD_KEY_LABEL, SHIFT_KEY_LABEL } = await importPlatformWith("Win32");
		expect(MOD_KEY_LABEL).toBe("Ctrl");
		expect(SHIFT_KEY_LABEL).toBe("Shift");
	});
});
