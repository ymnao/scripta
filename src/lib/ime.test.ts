import { describe, expect, it } from "vitest";
import { isIMEComposing } from "./ime";

function fakeKeyboardEvent(overrides: { isComposing?: boolean; keyCode?: number }) {
	return {
		nativeEvent: {
			isComposing: overrides.isComposing ?? false,
			keyCode: overrides.keyCode ?? 13,
		},
	} as React.KeyboardEvent;
}

describe("isIMEComposing", () => {
	it("returns true when isComposing is true", () => {
		expect(isIMEComposing(fakeKeyboardEvent({ isComposing: true }))).toBe(true);
	});

	it("returns true when keyCode is 229", () => {
		expect(isIMEComposing(fakeKeyboardEvent({ keyCode: 229 }))).toBe(true);
	});

	it("returns true when both isComposing and keyCode 229", () => {
		expect(isIMEComposing(fakeKeyboardEvent({ isComposing: true, keyCode: 229 }))).toBe(true);
	});

	it("returns false for normal Enter key", () => {
		expect(isIMEComposing(fakeKeyboardEvent({ keyCode: 13 }))).toBe(false);
	});

	it("returns true for a native KeyboardEvent with isComposing", () => {
		expect(isIMEComposing(new KeyboardEvent("keydown", { isComposing: true }))).toBe(true);
	});

	it("returns true for a native KeyboardEvent with keyCode 229", () => {
		expect(isIMEComposing(new KeyboardEvent("keydown", { key: "Escape", keyCode: 229 }))).toBe(true);
	});

	it("returns false for a native Escape outside composition", () => {
		expect(isIMEComposing(new KeyboardEvent("keydown", { key: "Escape" }))).toBe(false);
	});
});
