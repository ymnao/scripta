import { act, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from "vitest";

vi.mock("../../lib/commands", () => ({
	readFile: vi.fn(),
	writeFile: vi.fn(),
	openExternal: vi.fn(),
}));

vi.mock("../../stores/toast", () => ({
	useToastStore: {
		getState: () => ({ addToast: vi.fn() }),
	},
}));

const settingsState = {
	autoSaveDelay: 2000,
	trimTrailingWhitespace: true,
	fontSize: 14,
	showLineNumbers: false,
	highlightActiveLine: false,
	showLinkCards: false,
};
vi.mock("../../stores/settings", () => ({
	useSettingsStore: Object.assign(
		(selector: (s: typeof settingsState) => unknown) => selector(settingsState),
		{
			getState: () => settingsState,
			setState: (patch: Partial<typeof settingsState>) => Object.assign(settingsState, patch),
			subscribe: () => () => {},
		},
	),
}));

vi.mock("../../lib/scripta-config", () => ({
	getScratchpadPath: (ws: string) => `${ws}/.scripta/scratchpad.md`,
}));

// controlled CodeMirror を軽量 mock: value / onChange のみ露出。
// 内部の @codemirror/* を持ち込むと重いため。
vi.mock("@uiw/react-codemirror", () => ({
	default: ({ value, onChange }: { value: string; onChange?: (v: string) => void }) => (
		<div>
			<textarea
				data-testid="scratchpad-input"
				value={value}
				onChange={(e) => onChange?.(e.target.value)}
			/>
		</div>
	),
}));

const { readFile, writeFile } = await import("../../lib/commands");
const { ScratchpadPanel, scratchpadContentCache } = await import("./ScratchpadPanel");

const mockedReadFile = readFile as Mock;
const mockedWriteFile = writeFile as Mock;

describe("ScratchpadPanel", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		mockedReadFile.mockReset().mockResolvedValue("");
		mockedWriteFile.mockReset().mockResolvedValue(undefined);
		scratchpadContentCache.clear();
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	// #302: scheduleAutoSave() が同期的に getContent() を評価するため、handleChange
	// では setContent より先に contentRef.current を更新する。この配線ミスがあると
	// 直前値が保存され、最新の入力が失われる。
	it("handleChange writes the latest input to disk (contentRef ordering)", async () => {
		const { getByTestId } = render(<ScratchpadPanel workspacePath="/ws" onClose={() => {}} />);

		// readFile の resolve を await
		await act(async () => {
			await Promise.resolve();
		});

		const input = getByTestId("scratchpad-input") as HTMLTextAreaElement;
		await act(async () => {
			input.dispatchEvent(new Event("input", { bubbles: true }));
			// simulate onChange with new value
		});
		// @uiw/react-codemirror mock は input event を経由するので、直接 change event で
		// value を差し替える方が確実
		await act(async () => {
			const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
				HTMLTextAreaElement.prototype,
				"value",
			)?.set;
			nativeInputValueSetter?.call(input, "typed content");
			input.dispatchEvent(new Event("input", { bubbles: true }));
		});

		await act(async () => {
			vi.advanceTimersByTime(2000);
		});

		expect(mockedWriteFile).toHaveBeenCalledWith("/ws/.scripta/scratchpad.md", "typed content\n");
	});

	// #302 regression: scratchpadContentCache の re-hydrate で
	// cached.content !== cached.savedContent の場合、markSaved(saved, current) 経由で
	// dirty 状態を復元して autosave を再スケジュールする。
	it("re-hydrating cache with unsaved content restores dirty state and autosaves", async () => {
		// 前回セッションで unsaved のまま panel が閉じたキャッシュを設定
		scratchpadContentCache.set("/ws/.scripta/scratchpad.md", {
			content: "unsaved edits",
			savedContent: "old on disk",
		});

		render(<ScratchpadPanel workspacePath="/ws" onClose={() => {}} />);

		// readFile は cache hit なので走らない
		expect(mockedReadFile).not.toHaveBeenCalled();

		// autosave debounce が張られている
		await act(async () => {
			vi.advanceTimersByTime(2000);
		});

		expect(mockedWriteFile).toHaveBeenCalledWith("/ws/.scripta/scratchpad.md", "unsaved edits\n");
	});
});
