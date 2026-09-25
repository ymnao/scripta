import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { describe, expect, it } from "vitest";
import { createDynamicEditorTheme, staticEditorTheme } from "./editor-theme";

/** theme extension が生成する実 CSS テキストを取り出す。 */
function generatedCss(): string {
	return EditorState.create({
		extensions: [staticEditorTheme, createDynamicEditorTheme(16)],
	})
		.facet(EditorView.styleModule)
		.map((module) => module.getRules())
		.join("\n");
}

describe("コードブロックと blockquote の擬似要素", () => {
	// blockquote 内の fenced code 行は両方の line class を持つ
	// (code-blocks.test.ts「blockquote 内のコードブロック」で pin)。
	// 同じ擬似要素を使うと cascade で奪い合い、罫線が消えて背景も width: 3px の
	// 棒に潰れる。実際に一度踏んだ退行なので、使い分けを CSS レベルで pin する。
	it("blockquote の罫線は ::before、コードブロックの背景は ::after を使う", () => {
		const css = generatedCss();
		expect(css).toMatch(/\.cm-blockquote-line::before\b/);
		expect(css).toMatch(/\.cm-codeblock-line::after\b/);
		expect(css).not.toMatch(/\.cm-codeblock-line::before\b/);
	});
});
