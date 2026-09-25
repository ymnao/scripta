import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { describe, expect, it } from "vitest";
import { createDynamicEditorTheme, staticEditorTheme } from "./editor-theme";

/** theme extension が生成する実 CSS テキストを取り出す。
 *  blockquote の罫線は dynamic theme、コードブロックの背景は static theme 由来なので
 *  両方を合成しないと擬似要素の突き合わせができない。 */
function generatedCss(fontSize = 16): string {
	return EditorState.create({
		extensions: [staticEditorTheme, createDynamicEditorTheme(fontSize)],
	})
		.facet(EditorView.styleModule)
		.map((module) => module.getRules())
		.join("\n");
}

function ruleFor(css: string, selector: string): string | undefined {
	return css.match(new RegExp(`\\${selector}\\s*\\{[^}]*\\}`))?.[0];
}

describe("コードブロックの背景", () => {
	// blockquote 内の fenced code 行は両方の line class を持つ
	// (code-blocks.test.ts「blockquote 内のコードブロック」で pin)。
	// 同じ擬似要素を使うと cascade で奪い合い、罫線が消えて背景も width: 3px の
	// 棒に潰れる。実際に一度踏んだ退行なので、使い分けを CSS レベルで pin する。
	it("blockquote の罫線は ::before、コードブロックの背景は ::after を使う", () => {
		const css = generatedCss();
		expect(css).toMatch(/\.cm-blockquote-line::before\b/);
		expect(css).toMatch(/\.cm-codeblock-line::after\b/);
		// 奪い合いは対称なので、どちらが相手側へ越境しても壊れる。
		expect(css).not.toMatch(/\.cm-codeblock-line::before\b/);
		expect(css).not.toMatch(/\.cm-blockquote-line::after\b/);
	});

	// 元の不具合: 背景を .cm-line 自身に置いて background-clip: content-box で
	// horizontal padding を避ける方式は、vertical padding (1px) まで同時に削るため
	// 行ごとに 2px の隙間が入る。背景を擬似要素側だけに持たせることで塞いでいる。
	it("行本体は背景を持たず、擬似要素が padding box 全体を縦に覆う", () => {
		const css = generatedCss();
		const lineRule = ruleFor(css, ".cm-codeblock-line");
		expect(lineRule).toBeDefined();
		expect(lineRule).not.toMatch(/background/);

		const afterRule = ruleFor(css, ".cm-codeblock-line::after");
		expect(afterRule).toBeDefined();
		expect(afterRule).toMatch(/background-color/);
		expect(afterRule).toMatch(/top:\s*0/);
		expect(afterRule).toMatch(/bottom:\s*0/);
		// 正なら背景がテキストを覆う。
		expect(afterRule).toMatch(/z-index:\s*-1/);
	});
});
