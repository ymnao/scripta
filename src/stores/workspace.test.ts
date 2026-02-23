import { beforeEach, describe, expect, it } from "vitest";
import { useWorkspaceStore } from "./workspace";

function resetStore() {
	useWorkspaceStore.setState({
		workspacePath: null,
		tabs: [],
		activeTabPath: null,
		fileTreeVersion: 0,
	});
}

describe("useWorkspaceStore", () => {
	beforeEach(resetStore);

	it("has null/empty initial state", () => {
		const state = useWorkspaceStore.getState();
		expect(state.workspacePath).toBeNull();
		expect(state.tabs).toEqual([]);
		expect(state.activeTabPath).toBeNull();
	});

	describe("openTab", () => {
		it("adds a new tab and activates it", () => {
			useWorkspaceStore.getState().openTab("/a.md");
			const state = useWorkspaceStore.getState();
			expect(state.tabs).toEqual([{ path: "/a.md", dirty: false }]);
			expect(state.activeTabPath).toBe("/a.md");
		});

		it("does not duplicate an existing tab", () => {
			const { openTab } = useWorkspaceStore.getState();
			openTab("/a.md");
			openTab("/b.md");
			openTab("/a.md");

			const state = useWorkspaceStore.getState();
			expect(state.tabs).toHaveLength(2);
			expect(state.activeTabPath).toBe("/a.md");
		});

		it("maintains insertion order for multiple tabs", () => {
			const { openTab } = useWorkspaceStore.getState();
			openTab("/a.md");
			openTab("/b.md");
			openTab("/c.md");

			expect(useWorkspaceStore.getState().tabs.map((t) => t.path)).toEqual([
				"/a.md",
				"/b.md",
				"/c.md",
			]);
		});
	});

	describe("closeTab", () => {
		it("activates right neighbor when closing active middle tab", () => {
			const { openTab } = useWorkspaceStore.getState();
			openTab("/a.md");
			openTab("/b.md");
			openTab("/c.md");
			useWorkspaceStore.getState().setActiveTab("/b.md");

			useWorkspaceStore.getState().closeTab("/b.md");
			const state = useWorkspaceStore.getState();
			expect(state.tabs).toHaveLength(2);
			expect(state.activeTabPath).toBe("/c.md");
		});

		it("activates left neighbor when closing active last tab", () => {
			const { openTab } = useWorkspaceStore.getState();
			openTab("/a.md");
			openTab("/b.md");
			openTab("/c.md");

			useWorkspaceStore.getState().closeTab("/c.md");
			expect(useWorkspaceStore.getState().activeTabPath).toBe("/b.md");
		});

		it("sets activeTabPath to null when closing the only tab", () => {
			useWorkspaceStore.getState().openTab("/a.md");
			useWorkspaceStore.getState().closeTab("/a.md");

			const state = useWorkspaceStore.getState();
			expect(state.tabs).toEqual([]);
			expect(state.activeTabPath).toBeNull();
		});

		it("does not change activeTabPath when closing a non-active tab", () => {
			const { openTab } = useWorkspaceStore.getState();
			openTab("/a.md");
			openTab("/b.md");
			openTab("/c.md");

			useWorkspaceStore.getState().closeTab("/a.md");
			const state = useWorkspaceStore.getState();
			expect(state.activeTabPath).toBe("/c.md");
			expect(state.tabs).toHaveLength(2);
		});

		it("does nothing for a non-existent path", () => {
			useWorkspaceStore.getState().openTab("/a.md");
			useWorkspaceStore.getState().closeTab("/nonexistent.md");

			const state = useWorkspaceStore.getState();
			expect(state.tabs).toHaveLength(1);
			expect(state.activeTabPath).toBe("/a.md");
		});
	});

	describe("setActiveTab", () => {
		it("switches the active tab", () => {
			const { openTab } = useWorkspaceStore.getState();
			openTab("/a.md");
			openTab("/b.md");

			useWorkspaceStore.getState().setActiveTab("/a.md");
			expect(useWorkspaceStore.getState().activeTabPath).toBe("/a.md");
		});

		it("does nothing if the tab does not exist", () => {
			useWorkspaceStore.getState().openTab("/a.md");
			useWorkspaceStore.getState().setActiveTab("/nonexistent.md");

			expect(useWorkspaceStore.getState().activeTabPath).toBe("/a.md");
		});
	});

	describe("setTabDirty", () => {
		it("sets the dirty flag on a tab", () => {
			useWorkspaceStore.getState().openTab("/a.md");
			useWorkspaceStore.getState().setTabDirty("/a.md", true);

			expect(useWorkspaceStore.getState().tabs[0].dirty).toBe(true);
		});

		it("clears the dirty flag", () => {
			useWorkspaceStore.getState().openTab("/a.md");
			useWorkspaceStore.getState().setTabDirty("/a.md", true);
			useWorkspaceStore.getState().setTabDirty("/a.md", false);

			expect(useWorkspaceStore.getState().tabs[0].dirty).toBe(false);
		});
	});

	describe("renameTab", () => {
		it("renames a tab path", () => {
			const { openTab } = useWorkspaceStore.getState();
			openTab("/a.md");
			openTab("/b.md");

			useWorkspaceStore.getState().renameTab("/a.md", "/renamed.md");
			const state = useWorkspaceStore.getState();
			expect(state.tabs.map((t) => t.path)).toEqual(["/renamed.md", "/b.md"]);
		});

		it("updates activeTabPath when renaming the active tab", () => {
			const { openTab } = useWorkspaceStore.getState();
			openTab("/a.md");

			useWorkspaceStore.getState().renameTab("/a.md", "/renamed.md");
			expect(useWorkspaceStore.getState().activeTabPath).toBe("/renamed.md");
		});

		it("does not change activeTabPath when renaming a non-active tab", () => {
			const { openTab } = useWorkspaceStore.getState();
			openTab("/a.md");
			openTab("/b.md");

			useWorkspaceStore.getState().renameTab("/a.md", "/renamed.md");
			expect(useWorkspaceStore.getState().activeTabPath).toBe("/b.md");
		});
	});

	describe("replaceActiveTab", () => {
		it("creates a new tab when no active tab", () => {
			useWorkspaceStore.getState().replaceActiveTab("/a.md");
			const state = useWorkspaceStore.getState();
			expect(state.tabs).toEqual([{ path: "/a.md", dirty: false }]);
			expect(state.activeTabPath).toBe("/a.md");
		});

		it("switches to existing tab if newPath already open", () => {
			const { openTab } = useWorkspaceStore.getState();
			openTab("/a.md");
			openTab("/b.md");

			useWorkspaceStore.getState().replaceActiveTab("/a.md");
			const state = useWorkspaceStore.getState();
			expect(state.tabs).toHaveLength(2);
			expect(state.activeTabPath).toBe("/a.md");
		});

		it("replaces the active tab path", () => {
			const { openTab } = useWorkspaceStore.getState();
			openTab("/a.md");
			openTab("/b.md");
			// active is /b.md
			useWorkspaceStore.getState().replaceActiveTab("/c.md");
			const state = useWorkspaceStore.getState();
			expect(state.tabs.map((t) => t.path)).toEqual(["/a.md", "/c.md"]);
			expect(state.activeTabPath).toBe("/c.md");
		});

		it("resets dirty flag when replacing", () => {
			useWorkspaceStore.getState().openTab("/a.md");
			useWorkspaceStore.getState().setTabDirty("/a.md", true);
			useWorkspaceStore.getState().replaceActiveTab("/b.md");
			const tab = useWorkspaceStore.getState().tabs.find((t) => t.path === "/b.md");
			expect(tab?.dirty).toBe(false);
		});
	});

	describe("closeTabsByPrefix", () => {
		it("closes all tabs matching the prefix", () => {
			const { openTab } = useWorkspaceStore.getState();
			openTab("/dir/a.md");
			openTab("/dir/b.md");
			openTab("/other.md");

			useWorkspaceStore.getState().closeTabsByPrefix("/dir/");
			const state = useWorkspaceStore.getState();
			expect(state.tabs.map((t) => t.path)).toEqual(["/other.md"]);
		});

		it("updates activeTabPath when active tab is closed", () => {
			const { openTab } = useWorkspaceStore.getState();
			openTab("/other.md");
			openTab("/dir/a.md");

			useWorkspaceStore.getState().closeTabsByPrefix("/dir/");
			expect(useWorkspaceStore.getState().activeTabPath).toBe("/other.md");
		});

		it("selects right neighbor when closing active middle tab by prefix", () => {
			const { openTab } = useWorkspaceStore.getState();
			openTab("/a.md");
			openTab("/dir/b.md");
			openTab("/c.md");
			useWorkspaceStore.getState().setActiveTab("/dir/b.md");

			useWorkspaceStore.getState().closeTabsByPrefix("/dir/");
			expect(useWorkspaceStore.getState().activeTabPath).toBe("/c.md");
		});

		it("sets activeTabPath to null when all tabs are closed", () => {
			const { openTab } = useWorkspaceStore.getState();
			openTab("/dir/a.md");
			openTab("/dir/b.md");

			useWorkspaceStore.getState().closeTabsByPrefix("/dir/");
			expect(useWorkspaceStore.getState().activeTabPath).toBeNull();
		});

		it("does nothing when no tabs match", () => {
			const { openTab } = useWorkspaceStore.getState();
			openTab("/a.md");

			useWorkspaceStore.getState().closeTabsByPrefix("/nonexistent/");
			const state = useWorkspaceStore.getState();
			expect(state.tabs).toHaveLength(1);
		});
	});

	describe("reorderTab", () => {
		it("moves a tab from one position to another", () => {
			const { openTab } = useWorkspaceStore.getState();
			openTab("/a.md");
			openTab("/b.md");
			openTab("/c.md");

			useWorkspaceStore.getState().reorderTab(0, 2);
			expect(useWorkspaceStore.getState().tabs.map((t) => t.path)).toEqual([
				"/b.md",
				"/c.md",
				"/a.md",
			]);
		});

		it("moves a tab backward", () => {
			const { openTab } = useWorkspaceStore.getState();
			openTab("/a.md");
			openTab("/b.md");
			openTab("/c.md");

			useWorkspaceStore.getState().reorderTab(2, 0);
			expect(useWorkspaceStore.getState().tabs.map((t) => t.path)).toEqual([
				"/c.md",
				"/a.md",
				"/b.md",
			]);
		});

		it("does nothing when fromIndex equals toIndex", () => {
			const { openTab } = useWorkspaceStore.getState();
			openTab("/a.md");
			openTab("/b.md");

			useWorkspaceStore.getState().reorderTab(0, 0);
			expect(useWorkspaceStore.getState().tabs.map((t) => t.path)).toEqual(["/a.md", "/b.md"]);
		});

		it("does nothing for out-of-range indices", () => {
			const { openTab } = useWorkspaceStore.getState();
			openTab("/a.md");
			openTab("/b.md");

			useWorkspaceStore.getState().reorderTab(-1, 0);
			expect(useWorkspaceStore.getState().tabs.map((t) => t.path)).toEqual(["/a.md", "/b.md"]);

			useWorkspaceStore.getState().reorderTab(0, 5);
			expect(useWorkspaceStore.getState().tabs.map((t) => t.path)).toEqual(["/a.md", "/b.md"]);
		});

		it("does not change activeTabPath", () => {
			const { openTab } = useWorkspaceStore.getState();
			openTab("/a.md");
			openTab("/b.md");
			openTab("/c.md");

			useWorkspaceStore.getState().reorderTab(0, 2);
			expect(useWorkspaceStore.getState().activeTabPath).toBe("/c.md");
		});
	});

	describe("bumpFileTreeVersion", () => {
		it("increments fileTreeVersion", () => {
			expect(useWorkspaceStore.getState().fileTreeVersion).toBe(0);
			useWorkspaceStore.getState().bumpFileTreeVersion();
			expect(useWorkspaceStore.getState().fileTreeVersion).toBe(1);
			useWorkspaceStore.getState().bumpFileTreeVersion();
			expect(useWorkspaceStore.getState().fileTreeVersion).toBe(2);
		});
	});

	describe("setWorkspacePath", () => {
		it("resets tabs and activeTabPath", () => {
			const { openTab, setWorkspacePath } = useWorkspaceStore.getState();
			openTab("/old/a.md");
			openTab("/old/b.md");

			setWorkspacePath("/new/workspace");

			const state = useWorkspaceStore.getState();
			expect(state.workspacePath).toBe("/new/workspace");
			expect(state.tabs).toEqual([]);
			expect(state.activeTabPath).toBeNull();
		});

		it("clears workspace path", () => {
			const { setWorkspacePath } = useWorkspaceStore.getState();
			setWorkspacePath("/workspace");
			setWorkspacePath(null);

			const state = useWorkspaceStore.getState();
			expect(state.workspacePath).toBeNull();
			expect(state.tabs).toEqual([]);
			expect(state.activeTabPath).toBeNull();
		});
	});
});
