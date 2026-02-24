import { beforeEach, describe, expect, it } from "vitest";
import { useWorkspaceStore } from "./workspace";

function resetStore() {
	useWorkspaceStore.setState({
		workspacePath: null,
		tabs: [],
		activeTabPath: null,
		activeTabId: null,
		_nextTabId: 1,
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
		expect(state.activeTabId).toBeNull();
	});

	describe("openTab", () => {
		it("adds a new tab and activates it", () => {
			useWorkspaceStore.getState().openTab("/a.md");
			const state = useWorkspaceStore.getState();
			expect(state.tabs).toHaveLength(1);
			expect(state.tabs[0]).toMatchObject({ path: "/a.md", dirty: false });
			expect(state.tabs[0].id).toBe(1);
			expect(state.tabs[0].history).toEqual(["/a.md"]);
			expect(state.tabs[0].historyIndex).toBe(0);
			expect(state.activeTabPath).toBe("/a.md");
			expect(state.activeTabId).toBe(1);
		});

		it("does not duplicate an existing tab", () => {
			const { openTab } = useWorkspaceStore.getState();
			openTab("/a.md");
			openTab("/b.md");
			openTab("/a.md");

			const state = useWorkspaceStore.getState();
			expect(state.tabs).toHaveLength(2);
			expect(state.activeTabPath).toBe("/a.md");
			expect(state.activeTabId).toBe(1);
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

		it("assigns incrementing ids", () => {
			const { openTab } = useWorkspaceStore.getState();
			openTab("/a.md");
			openTab("/b.md");
			openTab("/c.md");

			const ids = useWorkspaceStore.getState().tabs.map((t) => t.id);
			expect(ids).toEqual([1, 2, 3]);
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
			expect(state.activeTabId).toBe(3);
		});

		it("activates left neighbor when closing active last tab", () => {
			const { openTab } = useWorkspaceStore.getState();
			openTab("/a.md");
			openTab("/b.md");
			openTab("/c.md");

			useWorkspaceStore.getState().closeTab("/c.md");
			expect(useWorkspaceStore.getState().activeTabPath).toBe("/b.md");
			expect(useWorkspaceStore.getState().activeTabId).toBe(2);
		});

		it("sets activeTabPath to null when closing the only tab", () => {
			useWorkspaceStore.getState().openTab("/a.md");
			useWorkspaceStore.getState().closeTab("/a.md");

			const state = useWorkspaceStore.getState();
			expect(state.tabs).toEqual([]);
			expect(state.activeTabPath).toBeNull();
			expect(state.activeTabId).toBeNull();
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

	describe("closeTabById", () => {
		it("closes tab by id", () => {
			const { openTab } = useWorkspaceStore.getState();
			openTab("/a.md");
			openTab("/b.md");

			const tabId = useWorkspaceStore.getState().tabs[0].id;
			useWorkspaceStore.getState().closeTabById(tabId);
			expect(useWorkspaceStore.getState().tabs).toHaveLength(1);
			expect(useWorkspaceStore.getState().tabs[0].path).toBe("/b.md");
		});

		it("activates right neighbor when closing active middle tab", () => {
			const { openTab } = useWorkspaceStore.getState();
			openTab("/a.md");
			openTab("/b.md");
			openTab("/c.md");
			useWorkspaceStore.getState().setActiveTab("/b.md");

			const bId = useWorkspaceStore.getState().tabs[1].id;
			useWorkspaceStore.getState().closeTabById(bId);
			expect(useWorkspaceStore.getState().activeTabPath).toBe("/c.md");
		});

		it("sets activeTabPath to null when closing the only tab", () => {
			useWorkspaceStore.getState().openTab("/a.md");
			const id = useWorkspaceStore.getState().tabs[0].id;
			useWorkspaceStore.getState().closeTabById(id);

			expect(useWorkspaceStore.getState().tabs).toEqual([]);
			expect(useWorkspaceStore.getState().activeTabPath).toBeNull();
			expect(useWorkspaceStore.getState().activeTabId).toBeNull();
		});

		it("does nothing for a non-existent id", () => {
			useWorkspaceStore.getState().openTab("/a.md");
			useWorkspaceStore.getState().closeTabById(999);

			expect(useWorkspaceStore.getState().tabs).toHaveLength(1);
		});

		it("does not change activeTabId when closing a non-active tab", () => {
			const { openTab } = useWorkspaceStore.getState();
			openTab("/a.md");
			openTab("/b.md");

			const aId = useWorkspaceStore.getState().tabs[0].id;
			useWorkspaceStore.getState().closeTabById(aId);
			expect(useWorkspaceStore.getState().activeTabId).toBe(2);
		});
	});

	describe("setActiveTab", () => {
		it("switches the active tab", () => {
			const { openTab } = useWorkspaceStore.getState();
			openTab("/a.md");
			openTab("/b.md");

			useWorkspaceStore.getState().setActiveTab("/a.md");
			expect(useWorkspaceStore.getState().activeTabPath).toBe("/a.md");
			expect(useWorkspaceStore.getState().activeTabId).toBe(1);
		});

		it("does nothing if the tab does not exist", () => {
			useWorkspaceStore.getState().openTab("/a.md");
			useWorkspaceStore.getState().setActiveTab("/nonexistent.md");

			expect(useWorkspaceStore.getState().activeTabPath).toBe("/a.md");
		});
	});

	describe("setActiveTabById", () => {
		it("switches the active tab by id", () => {
			const { openTab } = useWorkspaceStore.getState();
			openTab("/a.md");
			openTab("/b.md");

			useWorkspaceStore.getState().setActiveTabById(1);
			expect(useWorkspaceStore.getState().activeTabPath).toBe("/a.md");
			expect(useWorkspaceStore.getState().activeTabId).toBe(1);
		});

		it("does nothing if the tab id does not exist", () => {
			useWorkspaceStore.getState().openTab("/a.md");
			useWorkspaceStore.getState().setActiveTabById(999);

			expect(useWorkspaceStore.getState().activeTabPath).toBe("/a.md");
			expect(useWorkspaceStore.getState().activeTabId).toBe(1);
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
		it("renames a tab path and its history", () => {
			const { openTab } = useWorkspaceStore.getState();
			openTab("/a.md");
			openTab("/b.md");

			useWorkspaceStore.getState().renameTab("/a.md", "/renamed.md");
			const state = useWorkspaceStore.getState();
			expect(state.tabs.map((t) => t.path)).toEqual(["/renamed.md", "/b.md"]);
			expect(state.tabs[0].history).toEqual(["/renamed.md"]);
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

		it("renames matching paths in history", () => {
			useWorkspaceStore.getState().openTab("/a.md");
			// Manually build a history
			useWorkspaceStore.getState().navigateInTab("/b.md");
			useWorkspaceStore.getState().navigateInTab("/a.md");

			useWorkspaceStore.getState().renameTab("/a.md", "/renamed.md");
			const tab = useWorkspaceStore.getState().tabs[0];
			expect(tab.history).toEqual(["/renamed.md", "/b.md", "/renamed.md"]);
			expect(tab.path).toBe("/renamed.md");
		});
	});

	describe("renameTabsByPrefix", () => {
		it("renames paths matching the prefix in all tabs", () => {
			const { openTab } = useWorkspaceStore.getState();
			openTab("/dir/a.md");
			openTab("/other.md");

			useWorkspaceStore.getState().renameTabsByPrefix("/dir/", "/newdir/");
			const state = useWorkspaceStore.getState();
			expect(state.tabs.map((t) => t.path)).toEqual(["/newdir/a.md", "/other.md"]);
			expect(state.tabs[0].history).toEqual(["/newdir/a.md"]);
		});

		it("renames history entries matching the prefix", () => {
			useWorkspaceStore.getState().openTab("/dir/a.md");
			useWorkspaceStore.getState().navigateInTab("/dir/b.md");
			useWorkspaceStore.getState().navigateInTab("/other.md");

			useWorkspaceStore.getState().renameTabsByPrefix("/dir/", "/newdir/");
			const tab = useWorkspaceStore.getState().tabs[0];
			expect(tab.history).toEqual(["/newdir/a.md", "/newdir/b.md", "/other.md"]);
		});

		it("updates activeTabPath when active tab matches prefix", () => {
			useWorkspaceStore.getState().openTab("/dir/a.md");
			useWorkspaceStore.getState().renameTabsByPrefix("/dir/", "/newdir/");
			expect(useWorkspaceStore.getState().activeTabPath).toBe("/newdir/a.md");
		});

		it("does not change tabs that don't match", () => {
			useWorkspaceStore.getState().openTab("/other.md");
			useWorkspaceStore.getState().renameTabsByPrefix("/dir/", "/newdir/");
			expect(useWorkspaceStore.getState().tabs[0].path).toBe("/other.md");
		});
	});

	describe("navigateInTab", () => {
		it("does nothing when navigating to same path", () => {
			useWorkspaceStore.getState().openTab("/a.md");
			const tabsBefore = useWorkspaceStore.getState().tabs;
			useWorkspaceStore.getState().navigateInTab("/a.md");
			expect(useWorkspaceStore.getState().tabs).toBe(tabsBefore);
		});

		it("switches to existing tab if another tab has the path", () => {
			const { openTab } = useWorkspaceStore.getState();
			openTab("/a.md");
			openTab("/b.md");
			useWorkspaceStore.getState().setActiveTab("/a.md");

			useWorkspaceStore.getState().navigateInTab("/b.md");
			expect(useWorkspaceStore.getState().activeTabPath).toBe("/b.md");
			expect(useWorkspaceStore.getState().activeTabId).toBe(2);
		});

		it("creates new tab when no active tab", () => {
			useWorkspaceStore.getState().navigateInTab("/a.md");
			const state = useWorkspaceStore.getState();
			expect(state.tabs).toHaveLength(1);
			expect(state.tabs[0].path).toBe("/a.md");
			expect(state.activeTabPath).toBe("/a.md");
		});

		it("pushes to active tab's history", () => {
			useWorkspaceStore.getState().openTab("/a.md");
			useWorkspaceStore.getState().navigateInTab("/b.md");
			useWorkspaceStore.getState().navigateInTab("/c.md");

			const tab = useWorkspaceStore.getState().tabs[0];
			expect(tab.history).toEqual(["/a.md", "/b.md", "/c.md"]);
			expect(tab.historyIndex).toBe(2);
			expect(tab.path).toBe("/c.md");
		});

		it("truncates forward history on push", () => {
			useWorkspaceStore.getState().openTab("/a.md");
			useWorkspaceStore.getState().navigateInTab("/b.md");
			useWorkspaceStore.getState().navigateInTab("/c.md");
			useWorkspaceStore.getState().goBackInTab();
			useWorkspaceStore.getState().goBackInTab();
			// Now at /a.md, forward history is /b.md, /c.md
			useWorkspaceStore.getState().navigateInTab("/d.md");
			const tab = useWorkspaceStore.getState().tabs[0];
			expect(tab.history).toEqual(["/a.md", "/d.md"]);
			expect(tab.historyIndex).toBe(1);
		});

		it("caps history at 100 entries", () => {
			useWorkspaceStore.getState().openTab("/file-0.md");
			for (let i = 1; i < 110; i++) {
				useWorkspaceStore.getState().navigateInTab(`/file-${i}.md`);
			}
			const tab = useWorkspaceStore.getState().tabs[0];
			expect(tab.history).toHaveLength(100);
			expect(tab.history[0]).toBe("/file-10.md");
			expect(tab.historyIndex).toBe(99);
		});

		it("resets dirty flag when navigating to new path", () => {
			useWorkspaceStore.getState().openTab("/a.md");
			useWorkspaceStore.getState().setTabDirty("/a.md", true);
			useWorkspaceStore.getState().navigateInTab("/b.md");
			const tab = useWorkspaceStore.getState().tabs[0];
			expect(tab.dirty).toBe(false);
		});
	});

	describe("goBackInTab", () => {
		it("navigates back in active tab's history", () => {
			useWorkspaceStore.getState().openTab("/a.md");
			useWorkspaceStore.getState().navigateInTab("/b.md");

			useWorkspaceStore.getState().goBackInTab();
			const tab = useWorkspaceStore.getState().tabs[0];
			expect(tab.path).toBe("/a.md");
			expect(tab.historyIndex).toBe(0);
			expect(useWorkspaceStore.getState().activeTabPath).toBe("/a.md");
		});

		it("does nothing when at beginning", () => {
			useWorkspaceStore.getState().openTab("/a.md");
			const tabsBefore = useWorkspaceStore.getState().tabs;
			useWorkspaceStore.getState().goBackInTab();
			expect(useWorkspaceStore.getState().tabs).toBe(tabsBefore);
		});

		it("does nothing when no active tab", () => {
			const stateBefore = useWorkspaceStore.getState();
			useWorkspaceStore.getState().goBackInTab();
			expect(useWorkspaceStore.getState().tabs).toBe(stateBefore.tabs);
		});
	});

	describe("goForwardInTab", () => {
		it("navigates forward after goBack", () => {
			useWorkspaceStore.getState().openTab("/a.md");
			useWorkspaceStore.getState().navigateInTab("/b.md");
			useWorkspaceStore.getState().goBackInTab();

			useWorkspaceStore.getState().goForwardInTab();
			const tab = useWorkspaceStore.getState().tabs[0];
			expect(tab.path).toBe("/b.md");
			expect(tab.historyIndex).toBe(1);
			expect(useWorkspaceStore.getState().activeTabPath).toBe("/b.md");
		});

		it("does nothing when at end", () => {
			useWorkspaceStore.getState().openTab("/a.md");
			const tabsBefore = useWorkspaceStore.getState().tabs;
			useWorkspaceStore.getState().goForwardInTab();
			expect(useWorkspaceStore.getState().tabs).toBe(tabsBefore);
		});

		it("does nothing when no active tab", () => {
			const stateBefore = useWorkspaceStore.getState();
			useWorkspaceStore.getState().goForwardInTab();
			expect(useWorkspaceStore.getState().tabs).toBe(stateBefore.tabs);
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
			expect(useWorkspaceStore.getState().activeTabId).toBeNull();
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
		it("resets tabs, activeTabPath, activeTabId, and _nextTabId", () => {
			const { openTab, setWorkspacePath } = useWorkspaceStore.getState();
			openTab("/old/a.md");
			openTab("/old/b.md");

			setWorkspacePath("/new/workspace");

			const state = useWorkspaceStore.getState();
			expect(state.workspacePath).toBe("/new/workspace");
			expect(state.tabs).toEqual([]);
			expect(state.activeTabPath).toBeNull();
			expect(state.activeTabId).toBeNull();
			expect(state._nextTabId).toBe(1);
		});

		it("clears workspace path", () => {
			const { setWorkspacePath } = useWorkspaceStore.getState();
			setWorkspacePath("/workspace");
			setWorkspacePath(null);

			const state = useWorkspaceStore.getState();
			expect(state.workspacePath).toBeNull();
			expect(state.tabs).toEqual([]);
			expect(state.activeTabPath).toBeNull();
			expect(state.activeTabId).toBeNull();
		});
	});
});
