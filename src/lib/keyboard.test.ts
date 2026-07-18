import { describe, expect, it } from "vitest";
import { cmdOrCtrl } from "./keyboard";

describe("cmdOrCtrl", () => {
	it("metaKey のみ true で true", () => {
		expect(cmdOrCtrl({ metaKey: true, ctrlKey: false })).toBe(true);
	});

	it("ctrlKey のみ true で true", () => {
		expect(cmdOrCtrl({ metaKey: false, ctrlKey: true })).toBe(true);
	});

	it("両方 true で true", () => {
		expect(cmdOrCtrl({ metaKey: true, ctrlKey: true })).toBe(true);
	});

	it("両方 false で false", () => {
		expect(cmdOrCtrl({ metaKey: false, ctrlKey: false })).toBe(false);
	});

	it("KeyboardEvent を受け付ける", () => {
		const e = new KeyboardEvent("keydown", { key: "s", metaKey: true });
		expect(cmdOrCtrl(e)).toBe(true);
	});

	it("MouseEvent を受け付ける", () => {
		const e = new MouseEvent("click", { ctrlKey: true });
		expect(cmdOrCtrl(e)).toBe(true);
	});
});
