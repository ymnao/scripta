import { beforeEach, describe, expect, it } from "vitest";
import { useScratchpadStore } from "./scratchpad";

describe("useScratchpadStore", () => {
	beforeEach(() => {
		useScratchpadStore.setState({ open: false });
	});

	it("has open false by default", () => {
		expect(useScratchpadStore.getState().open).toBe(false);
	});

	it("toggle opens when closed", () => {
		useScratchpadStore.getState().toggle();
		expect(useScratchpadStore.getState().open).toBe(true);
	});

	it("toggle closes when open", () => {
		useScratchpadStore.setState({ open: true });
		useScratchpadStore.getState().toggle();
		expect(useScratchpadStore.getState().open).toBe(false);
	});

	it("setOpen sets open to true", () => {
		useScratchpadStore.getState().setOpen(true);
		expect(useScratchpadStore.getState().open).toBe(true);
	});

	it("setOpen sets open to false", () => {
		useScratchpadStore.setState({ open: true });
		useScratchpadStore.getState().setOpen(false);
		expect(useScratchpadStore.getState().open).toBe(false);
	});
});
