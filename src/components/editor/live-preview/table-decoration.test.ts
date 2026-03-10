import { describe, expect, it } from "vitest";
import { buildTableDecorations } from "./table-decoration";
import { collectDecorations, createTestState, replaceDecorations } from "./test-helper";

const simpleTable = `| A | B |
| --- | --- |
| 1 | 2 |`;

describe("buildTableDecorations", () => {
	it("テーブルがある場合、デコレーションが生成される", () => {
		const doc = `Hello\n\n${simpleTable}\n\nWorld`;
		const state = createTestState(doc);
		const decos = collectDecorations(buildTableDecorations(state));
		const replaces = replaceDecorations(decos);
		expect(replaces.length).toBe(1);
	});

	it("テーブルがない場合、デコレーションが生成されない", () => {
		const doc = "Hello\n\nWorld";
		const state = createTestState(doc);
		const decos = collectDecorations(buildTableDecorations(state));
		expect(decos.length).toBe(0);
	});

	it("2×2未満のテーブルはデコレーションされない", () => {
		const doc = "| A |\n| --- |\n| 1 |";
		const state = createTestState(doc);
		const decos = collectDecorations(buildTableDecorations(state));
		expect(decos.length).toBe(0);
	});

	it("複数テーブルがある場合、それぞれデコレーションされる", () => {
		const doc = `${simpleTable}\n\ntext\n\n${simpleTable}`;
		const state = createTestState(doc);
		const decos = collectDecorations(buildTableDecorations(state));
		const replaces = replaceDecorations(decos);
		expect(replaces.length).toBe(2);
	});
});
