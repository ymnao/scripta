import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/store", () => ({
	DEFAULT_FILE_TREE_EXCLUDE_PATTERNS: "",
	saveSetting: vi.fn(),
}));

import { saveSetting } from "../lib/store";
import { useSettingsStore } from "./settings";

describe("useSettingsStore", () => {
	beforeEach(() => {
		useSettingsStore.setState({
			showLineNumbers: true,
			fontSize: 14,
			autoSaveDelay: 2000,
			highlightActiveLine: false,
			fontFamily: "monospace",
			trimTrailingWhitespace: true,
			scratchpadVolatile: true,
		});
		vi.mocked(saveSetting).mockClear();
	});

	it("has showLineNumbers true by default", () => {
		expect(useSettingsStore.getState().showLineNumbers).toBe(true);
	});

	it("sets showLineNumbers to false", () => {
		useSettingsStore.getState().setShowLineNumbers(false);
		expect(useSettingsStore.getState().showLineNumbers).toBe(false);
		expect(saveSetting).toHaveBeenCalledWith("showLineNumbers", false);
	});

	it("sets showLineNumbers back to true", () => {
		useSettingsStore.getState().setShowLineNumbers(false);
		useSettingsStore.getState().setShowLineNumbers(true);
		expect(useSettingsStore.getState().showLineNumbers).toBe(true);
	});

	it("has fontSize 14 by default", () => {
		expect(useSettingsStore.getState().fontSize).toBe(14);
	});

	it("sets fontSize", () => {
		useSettingsStore.getState().setFontSize(20);
		expect(useSettingsStore.getState().fontSize).toBe(20);
		expect(saveSetting).toHaveBeenCalledWith("fontSize", 20);
	});

	it("has autoSaveDelay 2000 by default", () => {
		expect(useSettingsStore.getState().autoSaveDelay).toBe(2000);
	});

	it("sets autoSaveDelay", () => {
		useSettingsStore.getState().setAutoSaveDelay(5000);
		expect(useSettingsStore.getState().autoSaveDelay).toBe(5000);
		expect(saveSetting).toHaveBeenCalledWith("autoSaveDelay", 5000);
	});

	it("has highlightActiveLine false by default", () => {
		expect(useSettingsStore.getState().highlightActiveLine).toBe(false);
	});

	it("sets highlightActiveLine", () => {
		useSettingsStore.getState().setHighlightActiveLine(true);
		expect(useSettingsStore.getState().highlightActiveLine).toBe(true);
	});

	it("has fontFamily monospace by default", () => {
		expect(useSettingsStore.getState().fontFamily).toBe("monospace");
	});

	it("sets fontFamily", () => {
		useSettingsStore.getState().setFontFamily("serif");
		expect(useSettingsStore.getState().fontFamily).toBe("serif");
	});

	it("has trimTrailingWhitespace true by default", () => {
		expect(useSettingsStore.getState().trimTrailingWhitespace).toBe(true);
	});

	it("sets trimTrailingWhitespace", () => {
		useSettingsStore.getState().setTrimTrailingWhitespace(false);
		expect(useSettingsStore.getState().trimTrailingWhitespace).toBe(false);
	});

	it("setSlidePreviewWidthRatio clamps out-of-range values before persist (A4)", () => {
		// writer 側の clamp: 範囲外を渡しても store と disk には MIN/MAX にクランプされた
		// 値のみが到達する。future caller が誤って書いても preference が壊れないための防御。
		useSettingsStore.getState().setSlidePreviewWidthRatio(0.9);
		expect(useSettingsStore.getState().slidePreviewWidthRatio).toBe(0.7);
		expect(saveSetting).toHaveBeenLastCalledWith("slidePreviewWidthRatio", 0.7);

		useSettingsStore.getState().setSlidePreviewWidthRatio(0.05);
		expect(useSettingsStore.getState().slidePreviewWidthRatio).toBe(0.2);
		expect(saveSetting).toHaveBeenLastCalledWith("slidePreviewWidthRatio", 0.2);

		useSettingsStore.getState().setSlidePreviewWidthRatio(0.55);
		expect(useSettingsStore.getState().slidePreviewWidthRatio).toBe(0.55);
		expect(saveSetting).toHaveBeenLastCalledWith("slidePreviewWidthRatio", 0.55);
	});

	it("hydrate sets state without calling save functions", () => {
		vi.mocked(saveSetting).mockClear();

		useSettingsStore.getState().hydrate({
			fontSize: 20,
			autoSaveDelay: 5000,
			highlightActiveLine: true,
		});

		expect(useSettingsStore.getState().fontSize).toBe(20);
		expect(useSettingsStore.getState().autoSaveDelay).toBe(5000);
		expect(useSettingsStore.getState().highlightActiveLine).toBe(true);
		// saveSetting should NOT have been called during hydrate
		expect(saveSetting).not.toHaveBeenCalled();
	});
});
