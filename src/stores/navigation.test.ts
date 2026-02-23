import { beforeEach, describe, expect, it } from "vitest";
import { useNavigationStore } from "./navigation";

function resetStore() {
	useNavigationStore.setState({ history: [], historyIndex: -1 });
}

describe("useNavigationStore", () => {
	beforeEach(resetStore);

	describe("push", () => {
		it("adds a path to history", () => {
			useNavigationStore.getState().push("/a.md");
			const state = useNavigationStore.getState();
			expect(state.history).toEqual(["/a.md"]);
			expect(state.historyIndex).toBe(0);
		});

		it("skips duplicate consecutive paths", () => {
			const { push } = useNavigationStore.getState();
			push("/a.md");
			push("/a.md");
			const state = useNavigationStore.getState();
			expect(state.history).toEqual(["/a.md"]);
			expect(state.historyIndex).toBe(0);
		});

		it("truncates forward history on push", () => {
			const { push } = useNavigationStore.getState();
			push("/a.md");
			push("/b.md");
			push("/c.md");
			useNavigationStore.getState().goBack();
			useNavigationStore.getState().goBack();
			// Now at /a.md, forward history is /b.md, /c.md
			useNavigationStore.getState().push("/d.md");
			const state = useNavigationStore.getState();
			expect(state.history).toEqual(["/a.md", "/d.md"]);
			expect(state.historyIndex).toBe(1);
		});

		it("caps history at 100 entries", () => {
			const { push } = useNavigationStore.getState();
			for (let i = 0; i < 110; i++) {
				push(`/file-${i}.md`);
			}
			const state = useNavigationStore.getState();
			expect(state.history).toHaveLength(100);
			expect(state.history[0]).toBe("/file-10.md");
			expect(state.historyIndex).toBe(99);
		});
	});

	describe("goBack", () => {
		it("returns previous path", () => {
			const { push } = useNavigationStore.getState();
			push("/a.md");
			push("/b.md");
			const result = useNavigationStore.getState().goBack();
			expect(result).toBe("/a.md");
			expect(useNavigationStore.getState().historyIndex).toBe(0);
		});

		it("returns null when at beginning", () => {
			useNavigationStore.getState().push("/a.md");
			const result = useNavigationStore.getState().goBack();
			expect(result).toBeNull();
		});

		it("returns null when history is empty", () => {
			const result = useNavigationStore.getState().goBack();
			expect(result).toBeNull();
		});
	});

	describe("goForward", () => {
		it("returns next path after goBack", () => {
			const { push } = useNavigationStore.getState();
			push("/a.md");
			push("/b.md");
			useNavigationStore.getState().goBack();
			const result = useNavigationStore.getState().goForward();
			expect(result).toBe("/b.md");
			expect(useNavigationStore.getState().historyIndex).toBe(1);
		});

		it("returns null when at end", () => {
			useNavigationStore.getState().push("/a.md");
			const result = useNavigationStore.getState().goForward();
			expect(result).toBeNull();
		});

		it("returns null when history is empty", () => {
			const result = useNavigationStore.getState().goForward();
			expect(result).toBeNull();
		});
	});

	describe("reset", () => {
		it("clears history", () => {
			const { push } = useNavigationStore.getState();
			push("/a.md");
			push("/b.md");
			useNavigationStore.getState().reset();
			const state = useNavigationStore.getState();
			expect(state.history).toEqual([]);
			expect(state.historyIndex).toBe(-1);
		});
	});

	describe("renamePath", () => {
		it("renames matching paths in history", () => {
			const { push } = useNavigationStore.getState();
			push("/a.md");
			push("/b.md");
			push("/a.md");
			useNavigationStore.getState().renamePath("/a.md", "/renamed.md");
			expect(useNavigationStore.getState().history).toEqual([
				"/renamed.md",
				"/b.md",
				"/renamed.md",
			]);
		});

		it("does not change non-matching paths", () => {
			const { push } = useNavigationStore.getState();
			push("/a.md");
			push("/b.md");
			useNavigationStore.getState().renamePath("/c.md", "/renamed.md");
			expect(useNavigationStore.getState().history).toEqual(["/a.md", "/b.md"]);
		});
	});

	describe("renamePathsByPrefix", () => {
		it("renames paths matching the prefix", () => {
			const { push } = useNavigationStore.getState();
			push("/dir/a.md");
			push("/other.md");
			push("/dir/b.md");
			useNavigationStore.getState().renamePathsByPrefix("/dir/", "/newdir/");
			expect(useNavigationStore.getState().history).toEqual([
				"/newdir/a.md",
				"/other.md",
				"/newdir/b.md",
			]);
		});
	});
});
