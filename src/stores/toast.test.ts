import { afterEach, describe, expect, it } from "vitest";
import { useToastStore } from "./toast";

describe("useToastStore", () => {
	afterEach(() => {
		useToastStore.setState({ toasts: [] });
	});

	it("starts with empty toasts", () => {
		expect(useToastStore.getState().toasts).toEqual([]);
	});

	it("adds a toast and returns its id", () => {
		const id = useToastStore.getState().addToast("error", "Something went wrong");
		expect(id).toMatch(/^toast-/);
		const toasts = useToastStore.getState().toasts;
		expect(toasts).toHaveLength(1);
		expect(toasts[0]).toEqual({ id, type: "error", message: "Something went wrong" });
	});

	it("adds multiple toasts", () => {
		useToastStore.getState().addToast("error", "Error 1");
		useToastStore.getState().addToast("warning", "Warning 1");
		expect(useToastStore.getState().toasts).toHaveLength(2);
	});

	it("removes a toast by id", () => {
		const id1 = useToastStore.getState().addToast("error", "Error 1");
		const id2 = useToastStore.getState().addToast("warning", "Warning 1");
		useToastStore.getState().removeToast(id1);
		const toasts = useToastStore.getState().toasts;
		expect(toasts).toHaveLength(1);
		expect(toasts[0].id).toBe(id2);
	});

	it("does nothing when removing non-existent id", () => {
		useToastStore.getState().addToast("error", "Error 1");
		useToastStore.getState().removeToast("toast-nonexistent");
		expect(useToastStore.getState().toasts).toHaveLength(1);
	});
});
