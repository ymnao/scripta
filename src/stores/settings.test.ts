import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/store", () => ({
	saveShowLineNumbers: vi.fn(),
	saveFontSize: vi.fn(),
	saveAutoSaveDelay: vi.fn(),
	saveHighlightActiveLine: vi.fn(),
	saveFontFamily: vi.fn(),
	saveTrimTrailingWhitespace: vi.fn(),
}));

import { saveAutoSaveDelay, saveFontSize } from "../lib/store";
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
		});
	});

	it("has showLineNumbers true by default", () => {
		expect(useSettingsStore.getState().showLineNumbers).toBe(true);
	});

	it("sets showLineNumbers to false", () => {
		useSettingsStore.getState().setShowLineNumbers(false);
		expect(useSettingsStore.getState().showLineNumbers).toBe(false);
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
	});

	it("has autoSaveDelay 2000 by default", () => {
		expect(useSettingsStore.getState().autoSaveDelay).toBe(2000);
	});

	it("sets autoSaveDelay", () => {
		useSettingsStore.getState().setAutoSaveDelay(5000);
		expect(useSettingsStore.getState().autoSaveDelay).toBe(5000);
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

	it("hydrate sets state without calling save functions", () => {
		vi.mocked(saveFontSize).mockClear();
		vi.mocked(saveAutoSaveDelay).mockClear();

		useSettingsStore.getState().hydrate({
			fontSize: 20,
			autoSaveDelay: 5000,
			highlightActiveLine: true,
		});

		expect(useSettingsStore.getState().fontSize).toBe(20);
		expect(useSettingsStore.getState().autoSaveDelay).toBe(5000);
		expect(useSettingsStore.getState().highlightActiveLine).toBe(true);
		// save functions should NOT have been called
		expect(saveFontSize).not.toHaveBeenCalled();
		expect(saveAutoSaveDelay).not.toHaveBeenCalled();
	});
});
