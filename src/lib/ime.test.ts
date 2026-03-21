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
});
