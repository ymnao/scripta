import { describe, expect, it } from "vitest";
import { buildTableDecorations } from "./table-decoration";
import {
	collectDecorations,
	createTestState,
	replaceDecorations,
	widgetDecorations,
} from "./test-helper";

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

	it("アライメントが異なるテーブルは異なるウィジェットを生成する", () => {
		const leftTable = "| A | B |\n| :--- | :--- |\n| 1 | 2 |";
		const rightTable = "| A | B |\n| ---: | ---: |\n| 1 | 2 |";
		const centerTable = "| A | B |\n| :---: | :---: |\n| 1 | 2 |";

		const stateL = createTestState(leftTable);
		const stateR = createTestState(rightTable);
		const stateC = createTestState(centerTable);

		const widgetL = widgetDecorations(collectDecorations(buildTableDecorations(stateL)));
		const widgetR = widgetDecorations(collectDecorations(buildTableDecorations(stateR)));
		const widgetC = widgetDecorations(collectDecorations(buildTableDecorations(stateC)));

		expect(widgetL.length).toBe(1);
		expect(widgetR.length).toBe(1);
		expect(widgetC.length).toBe(1);

		// eq() should return false for different alignments
		const wL = widgetL[0].value.spec.widget;
		const wR = widgetR[0].value.spec.widget;
		const wC = widgetC[0].value.spec.widget;
		expect(wL.eq(wR)).toBe(false);
		expect(wL.eq(wC)).toBe(false);
		expect(wR.eq(wC)).toBe(false);
	});

	describe("ignoreEvent", () => {
		function getWidget() {
			const state = createTestState(simpleTable);
			const decos = widgetDecorations(collectDecorations(buildTableDecorations(state)));
			return decos[0].value.spec.widget;
		}

		it("セル内クリックは true を返す（ウィジェットが処理）", () => {
			const widget = getWidget();
			const td = document.createElement("td");
			const event = new MouseEvent("mousedown", { bubbles: true });
			Object.defineProperty(event, "target", { value: td });
			expect(widget.ignoreEvent(event)).toBe(true);
		});

		it("セル外（padding 帯）クリックは false を返す（エディタに委譲）", () => {
			const widget = getWidget();
			const div = document.createElement("div");
			const event = new MouseEvent("mousedown", { bubbles: true });
			Object.defineProperty(event, "target", { value: div });
			expect(widget.ignoreEvent(event)).toBe(false);
		});

		it("セル外の Text ノードは false を返す（エディタに委譲）", () => {
			const widget = getWidget();
			const div = document.createElement("div");
			const text = document.createTextNode("hello");
			div.appendChild(text);
			const event = new MouseEvent("mousedown", { bubbles: true });
			Object.defineProperty(event, "target", { value: text });
			expect(widget.ignoreEvent(event)).toBe(false);
		});

		it("セル内の Text ノードは parentElement 経由で true を返す", () => {
			const widget = getWidget();
			const td = document.createElement("td");
			const text = document.createTextNode("cell text");
			td.appendChild(text);
			const event = new MouseEvent("mousedown", { bubbles: true });
			Object.defineProperty(event, "target", { value: text });
			expect(widget.ignoreEvent(event)).toBe(true);
		});

		it("Ctrl/Cmd+キーは false を返す", () => {
			const widget = getWidget();
			const event = new KeyboardEvent("keydown", { key: "s", metaKey: true });
			expect(widget.ignoreEvent(event)).toBe(false);
		});
	});

	it("同じアライメント・内容のテーブルは eq() が true を返す", () => {
		const table = "| A | B |\n| :---: | --- |\n| 1 | 2 |";
		const state1 = createTestState(table);
		const state2 = createTestState(table);

		const w1 = widgetDecorations(collectDecorations(buildTableDecorations(state1)));
		const w2 = widgetDecorations(collectDecorations(buildTableDecorations(state2)));

		expect(w1[0].value.spec.widget.eq(w2[0].value.spec.widget)).toBe(true);
	});
});
