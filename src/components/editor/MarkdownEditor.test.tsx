import { EditorSelection } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../stores/settings", () => ({
	useSettingsStore: (selector: (s: Record<string, unknown>) => unknown) =>
		selector({
			showLineNumbers: false,
			fontSize: 14,
			fontFamily: "monospace",
			highlightActiveLine: false,
			showLinkCards: false,
		}),
}));

vi.mock("mermaid", () => ({
	default: {
		initialize: vi.fn(),
		render: vi.fn().mockResolvedValue({ svg: "<svg></svg>" }),
		parse: vi.fn().mockResolvedValue(true),
	},
}));

import { MarkdownEditor } from "./MarkdownEditor";

function getMenuLabels() {
	return screen
		.getAllByRole("menuitem")
		.map((el) => el.querySelector("span")?.textContent?.trim() ?? "");
}

function clickMenuItem(label: string) {
	const items = screen.getAllByRole("menuitem");
	const target = items.find((el) => el.textContent?.includes(label));
	if (!target) throw new Error(`Menu item "${label}" not found`);
	return userEvent.click(target);
}

function renderEditor(value: string, onChange?: (v: string) => void) {
	let editorView: EditorView | null = null;
	const onEditorView = (view: EditorView | null) => {
		editorView = view;
	};
	const result = render(
		<MarkdownEditor
			value={value}
			onChange={onChange ?? (() => {})}
			onSave={() => {}}
			onEditorView={onEditorView}
		/>,
	);
	const getView = (): EditorView => {
		if (!editorView) throw new Error("EditorView not initialized");
		return editorView;
	};
	return { ...result, getView };
}

function selectRange(view: EditorView, from: number, to: number) {
	view.dispatch({ selection: EditorSelection.range(from, to) });
}

async function openContextMenu(container: HTMLElement) {
	const editor = container.querySelector(".cm-content");
	if (!editor) throw new Error("CodeMirror .cm-content not found");
	// jsdom has no layout, so posAtCoords maps all coordinates to a position
	// near the start of the document. Use (0,0) so the returned position
	// stays within a [0, N] selection range and doesn't clear it.
	await act(async () => {
		fireEvent.contextMenu(editor, { clientX: 0, clientY: 0 });
	});
}

/** Wait a microtask for promises to settle */
async function flush() {
	await act(async () => {
		await new Promise((r) => setTimeout(r, 0));
	});
}

describe("MarkdownEditor context menu", () => {
	let originalClipboard: Clipboard;

	beforeEach(() => {
		originalClipboard = navigator.clipboard;
	});

	afterEach(() => {
		Object.defineProperty(navigator, "clipboard", {
			value: originalClipboard,
			configurable: true,
		});
	});

	// ── Menu items based on selection state ────────────

	it("shows insert items when no text is selected", async () => {
		const { container } = renderEditor("hello world");
		await openContextMenu(container);

		const items = getMenuLabels();
		expect(items).toContain("貼り付け");
		expect(items).toContain("元に戻す");
		expect(items).toContain("やり直す");
		expect(items).toContain("テーブルを挿入");
		expect(items).toContain("水平線を挿入");
		expect(items).toContain("Mermaid 図を挿入");
		expect(items).not.toContain("切り取り");
		expect(items).not.toContain("コピー");
		expect(items).not.toContain("太字");
	});

	it("shows edit/format items when text is selected", async () => {
		const { container, getView } = renderEditor("hello world");
		const view = getView();
		selectRange(view, 0, 5);
		await openContextMenu(container);

		const items = getMenuLabels();
		expect(items).toContain("切り取り");
		expect(items).toContain("コピー");
		expect(items).toContain("貼り付け");
		expect(items).toContain("元に戻す");
		expect(items).toContain("やり直す");
		expect(items).toContain("太字");
		expect(items).toContain("斜体");
		expect(items).toContain("取り消し線");
		expect(items).not.toContain("テーブルを挿入");
		expect(items).not.toContain("水平線を挿入");
	});

	// ── Clipboard unavailable ──────────────────────────

	it("does not throw when clipboard is unavailable (paste, no selection)", async () => {
		Object.defineProperty(navigator, "clipboard", { value: undefined, configurable: true });
		const { container } = renderEditor("hello world");
		await openContextMenu(container);
		await clickMenuItem("貼り付け");
	});

	it("does not throw when clipboard is unavailable (cut, with selection)", async () => {
		Object.defineProperty(navigator, "clipboard", { value: undefined, configurable: true });
		const { container, getView } = renderEditor("hello world");
		selectRange(getView(), 0, 5);
		await openContextMenu(container);
		await clickMenuItem("切り取り");
	});

	it("does not throw when clipboard is unavailable (copy, with selection)", async () => {
		Object.defineProperty(navigator, "clipboard", { value: undefined, configurable: true });
		const { container, getView } = renderEditor("hello world");
		selectRange(getView(), 0, 5);
		await openContextMenu(container);
		await clickMenuItem("コピー");
	});

	// ── Clipboard rejection ────────────────────────────

	it("does not throw when writeText rejects (cut)", async () => {
		const writeText = vi.fn().mockRejectedValue(new Error("Permission denied"));
		Object.defineProperty(navigator, "clipboard", {
			value: { writeText, readText: vi.fn() },
			configurable: true,
		});
		const { container, getView } = renderEditor("hello world");
		selectRange(getView(), 0, 5);
		await openContextMenu(container);
		await clickMenuItem("切り取り");
		await flush();
		expect(writeText).toHaveBeenCalledWith("hello");
	});

	it("does not throw when writeText rejects (copy)", async () => {
		const writeText = vi.fn().mockRejectedValue(new Error("Permission denied"));
		Object.defineProperty(navigator, "clipboard", {
			value: { writeText, readText: vi.fn() },
			configurable: true,
		});
		const { container, getView } = renderEditor("hello world");
		selectRange(getView(), 0, 5);
		await openContextMenu(container);
		await clickMenuItem("コピー");
		await flush();
		expect(writeText).toHaveBeenCalledWith("hello");
	});

	it("does not throw when readText rejects (paste, no selection)", async () => {
		const readText = vi.fn().mockRejectedValue(new Error("Permission denied"));
		Object.defineProperty(navigator, "clipboard", {
			value: { writeText: vi.fn(), readText },
			configurable: true,
		});
		const { container } = renderEditor("hello world");
		await openContextMenu(container);
		await clickMenuItem("貼り付け");
		await flush();
		expect(readText).toHaveBeenCalled();
	});

	it("does not throw when readText rejects (paste, with selection)", async () => {
		const readText = vi.fn().mockRejectedValue(new Error("Permission denied"));
		Object.defineProperty(navigator, "clipboard", {
			value: { writeText: vi.fn(), readText },
			configurable: true,
		});
		const { container, getView } = renderEditor("hello world");
		selectRange(getView(), 0, 5);
		await openContextMenu(container);
		await clickMenuItem("貼り付け");
		await flush();
		expect(readText).toHaveBeenCalled();
	});

	// ── Successful clipboard operations ────────────────

	it("cut: copies to clipboard then deletes selection", async () => {
		const writeText = vi.fn().mockResolvedValue(undefined);
		Object.defineProperty(navigator, "clipboard", {
			value: { writeText, readText: vi.fn() },
			configurable: true,
		});
		let currentValue = "";
		const { container, getView } = renderEditor("hello world", (v) => {
			currentValue = v;
		});
		selectRange(getView(), 0, 5);
		await openContextMenu(container);
		await clickMenuItem("切り取り");
		await flush();
		expect(writeText).toHaveBeenCalledWith("hello");
		expect(currentValue).toBe(" world");
	});

	it("copy: copies to clipboard without modifying document", async () => {
		const writeText = vi.fn().mockResolvedValue(undefined);
		Object.defineProperty(navigator, "clipboard", {
			value: { writeText, readText: vi.fn() },
			configurable: true,
		});
		const onChange = vi.fn();
		const { container, getView } = renderEditor("hello world", onChange);
		selectRange(getView(), 0, 5);
		await openContextMenu(container);
		await clickMenuItem("コピー");
		await flush();
		expect(writeText).toHaveBeenCalledWith("hello");
		expect(onChange).not.toHaveBeenCalled();
	});

	// ── Insert operations ──────────────────────────────

	it("inserts horizontal rule via context menu", async () => {
		let currentValue = "";
		const { container } = renderEditor("", (v) => {
			currentValue = v;
		});
		await openContextMenu(container);
		await clickMenuItem("水平線を挿入");
		expect(currentValue).toContain("---");
	});

	// ── Formatting operations ──────────────────────────

	it("applies bold formatting via context menu", async () => {
		let currentValue = "";
		const { container, getView } = renderEditor("hello world", (v) => {
			currentValue = v;
		});
		selectRange(getView(), 0, 5);
		await openContextMenu(container);
		await clickMenuItem("太字");
		expect(currentValue).toContain("**hello**");
	});

	it("applies italic formatting via context menu", async () => {
		let currentValue = "";
		const { container, getView } = renderEditor("hello world", (v) => {
			currentValue = v;
		});
		selectRange(getView(), 0, 5);
		await openContextMenu(container);
		await clickMenuItem("斜体");
		expect(currentValue).toContain("*hello*");
	});

	it("applies strikethrough formatting via context menu", async () => {
		let currentValue = "";
		const { container, getView } = renderEditor("hello world", (v) => {
			currentValue = v;
		});
		selectRange(getView(), 0, 5);
		await openContextMenu(container);
		await clickMenuItem("取り消し線");
		expect(currentValue).toContain("~~hello~~");
	});
});
