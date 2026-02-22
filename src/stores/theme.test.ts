import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/store", () => ({
	saveThemePreference: vi.fn(),
}));

import { useThemeStore } from "./theme";

describe("useThemeStore", () => {
	beforeEach(() => {
		useThemeStore.setState({ preference: "system", theme: "light" });
		document.documentElement.classList.remove("dark");
	});

	it("has initial preference and resolved theme", () => {
		const state = useThemeStore.getState();
		expect(state.preference).toBeDefined();
		expect(state.theme).toBeDefined();
	});

	describe("setPreference", () => {
		it("sets preference to dark and resolves theme", () => {
			useThemeStore.getState().setPreference("dark");
			const state = useThemeStore.getState();
			expect(state.preference).toBe("dark");
			expect(state.theme).toBe("dark");
		});

		it("sets preference to light and resolves theme", () => {
			useThemeStore.getState().setPreference("light");
			const state = useThemeStore.getState();
			expect(state.preference).toBe("light");
			expect(state.theme).toBe("light");
		});

		it("sets preference to system", () => {
			useThemeStore.getState().setPreference("system");
			expect(useThemeStore.getState().preference).toBe("system");
		});
	});

	describe("cyclePreference", () => {
		it("cycles system → light → dark → system", () => {
			useThemeStore.setState({ preference: "system", theme: "light" });

			useThemeStore.getState().cyclePreference();
			expect(useThemeStore.getState().preference).toBe("light");

			useThemeStore.getState().cyclePreference();
			expect(useThemeStore.getState().preference).toBe("dark");

			useThemeStore.getState().cyclePreference();
			expect(useThemeStore.getState().preference).toBe("system");
		});
	});
});
