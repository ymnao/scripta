import { type Mock, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/scripta-config", () => ({
	loadIcons: vi.fn(),
	saveIcons: vi.fn().mockResolvedValue(undefined),
	scriptaDirExists: vi.fn(),
}));

const {
	loadIcons: loadIconsFromDisk,
	saveIcons,
	scriptaDirExists,
} = await import("../lib/scripta-config");
const { useWorkspaceConfigStore, toRelativePath } = await import("./workspace-config");

const mockedLoadIcons = loadIconsFromDisk as Mock;
const mockedSaveIcons = saveIcons as Mock;
const mockedScriptaDirExists = scriptaDirExists as Mock;

describe("useWorkspaceConfigStore", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		useWorkspaceConfigStore.setState({ icons: {}, scriptaDirReady: false });
	});

	it("has empty icons by default", () => {
		expect(useWorkspaceConfigStore.getState().icons).toEqual({});
	});

	it("has scriptaDirReady false by default", () => {
		expect(useWorkspaceConfigStore.getState().scriptaDirReady).toBe(false);
	});

	describe("loadIcons", () => {
		it("loads icons from disk and sets scriptaDirReady when dir exists", async () => {
			mockedLoadIcons.mockResolvedValue({ "file.md": "📄" });
			mockedScriptaDirExists.mockResolvedValue(true);
			await useWorkspaceConfigStore.getState().loadIcons("/workspace");
			expect(useWorkspaceConfigStore.getState().icons).toEqual({ "file.md": "📄" });
			expect(useWorkspaceConfigStore.getState().scriptaDirReady).toBe(true);
		});

		it("sets scriptaDirReady true when dir exists but icons are empty", async () => {
			mockedLoadIcons.mockResolvedValue({});
			mockedScriptaDirExists.mockResolvedValue(true);
			await useWorkspaceConfigStore.getState().loadIcons("/workspace");
			expect(useWorkspaceConfigStore.getState().icons).toEqual({});
			expect(useWorkspaceConfigStore.getState().scriptaDirReady).toBe(true);
		});

		it("sets scriptaDirReady false when dir does not exist", async () => {
			mockedLoadIcons.mockResolvedValue({});
			mockedScriptaDirExists.mockResolvedValue(false);
			await useWorkspaceConfigStore.getState().loadIcons("/workspace");
			expect(useWorkspaceConfigStore.getState().icons).toEqual({});
			expect(useWorkspaceConfigStore.getState().scriptaDirReady).toBe(false);
		});
	});

	describe("setIcon", () => {
		it("adds an icon and persists to disk", () => {
			useWorkspaceConfigStore.getState().setIcon("/workspace", "file.md", "📝");
			expect(useWorkspaceConfigStore.getState().icons).toEqual({ "file.md": "📝" });
			expect(useWorkspaceConfigStore.getState().scriptaDirReady).toBe(true);
			expect(mockedSaveIcons).toHaveBeenCalledWith("/workspace", { "file.md": "📝" });
		});

		it("overwrites an existing icon", () => {
			useWorkspaceConfigStore.setState({ icons: { "file.md": "📄" } });
			useWorkspaceConfigStore.getState().setIcon("/workspace", "file.md", "🔥");
			expect(useWorkspaceConfigStore.getState().icons).toEqual({ "file.md": "🔥" });
		});
	});

	describe("removeIcon", () => {
		it("removes an icon and persists to disk", () => {
			useWorkspaceConfigStore.setState({ icons: { "file.md": "📄", src: "🔧" } });
			useWorkspaceConfigStore.getState().removeIcon("/workspace", "file.md");
			expect(useWorkspaceConfigStore.getState().icons).toEqual({ src: "🔧" });
			expect(mockedSaveIcons).toHaveBeenCalledWith("/workspace", { src: "🔧" });
		});
	});

	describe("renameIcon", () => {
		it("moves icon from old key to new key", () => {
			useWorkspaceConfigStore.setState({ icons: { "old.md": "📄", "other.md": "🔧" } });
			useWorkspaceConfigStore.getState().renameIcon("/workspace", "old.md", "new.md");
			expect(useWorkspaceConfigStore.getState().icons).toEqual({
				"new.md": "📄",
				"other.md": "🔧",
			});
			expect(mockedSaveIcons).toHaveBeenCalledWith("/workspace", {
				"new.md": "📄",
				"other.md": "🔧",
			});
		});

		it("does nothing when old key does not exist", () => {
			useWorkspaceConfigStore.setState({ icons: { "file.md": "📄" } });
			useWorkspaceConfigStore.getState().renameIcon("/workspace", "missing.md", "new.md");
			expect(useWorkspaceConfigStore.getState().icons).toEqual({ "file.md": "📄" });
			expect(mockedSaveIcons).not.toHaveBeenCalled();
		});
	});

	describe("renameIconsByPrefix", () => {
		it("renames all keys under the old prefix", () => {
			useWorkspaceConfigStore.setState({
				icons: { docs: "📁", "docs/a.md": "📄", "docs/sub/b.md": "📝", "other.md": "🔧" },
			});
			useWorkspaceConfigStore.getState().renameIconsByPrefix("/workspace", "docs", "documents");
			expect(useWorkspaceConfigStore.getState().icons).toEqual({
				documents: "📁",
				"documents/a.md": "📄",
				"documents/sub/b.md": "📝",
				"other.md": "🔧",
			});
			expect(mockedSaveIcons).toHaveBeenCalled();
		});

		it("renames folder-style keys with trailing slash and descendants", () => {
			useWorkspaceConfigStore.setState({
				icons: {
					"docs/": "📁",
					"docs/a.md": "📄",
					"docs/sub/b.md": "📝",
					"other.md": "🔧",
				},
			});
			useWorkspaceConfigStore.getState().renameIconsByPrefix("/workspace", "docs/", "documents/");
			expect(useWorkspaceConfigStore.getState().icons).toEqual({
				"documents/": "📁",
				"documents/a.md": "📄",
				"documents/sub/b.md": "📝",
				"other.md": "🔧",
			});
			expect(mockedSaveIcons).toHaveBeenCalledWith("/workspace", {
				"documents/": "📁",
				"documents/a.md": "📄",
				"documents/sub/b.md": "📝",
				"other.md": "🔧",
			});
		});

		it("does nothing when no keys match the prefix", () => {
			useWorkspaceConfigStore.setState({ icons: { "file.md": "📄" } });
			useWorkspaceConfigStore.getState().renameIconsByPrefix("/workspace", "docs", "documents");
			expect(useWorkspaceConfigStore.getState().icons).toEqual({ "file.md": "📄" });
			expect(mockedSaveIcons).not.toHaveBeenCalled();
		});
	});

	describe("deleteIconsByPrefix", () => {
		it("deletes the folder key and all keys under the prefix", () => {
			useWorkspaceConfigStore.setState({
				icons: { docs: "📁", "docs/a.md": "📄", "docs/sub/b.md": "📝", "other.md": "🔧" },
			});
			useWorkspaceConfigStore.getState().deleteIconsByPrefix("/workspace", "docs");
			expect(useWorkspaceConfigStore.getState().icons).toEqual({ "other.md": "🔧" });
			expect(mockedSaveIcons).toHaveBeenCalledWith("/workspace", { "other.md": "🔧" });
		});

		it("does nothing when no keys match the prefix", () => {
			useWorkspaceConfigStore.setState({ icons: { "file.md": "📄" } });
			useWorkspaceConfigStore.getState().deleteIconsByPrefix("/workspace", "docs");
			expect(useWorkspaceConfigStore.getState().icons).toEqual({ "file.md": "📄" });
			expect(mockedSaveIcons).not.toHaveBeenCalled();
		});
	});

	describe("setScriptaDirReady", () => {
		it("sets scriptaDirReady", () => {
			useWorkspaceConfigStore.getState().setScriptaDirReady(true);
			expect(useWorkspaceConfigStore.getState().scriptaDirReady).toBe(true);
		});
	});

	describe("reset", () => {
		it("resets icons and scriptaDirReady", () => {
			useWorkspaceConfigStore.setState({
				icons: { "file.md": "📄" },
				scriptaDirReady: true,
			});
			useWorkspaceConfigStore.getState().reset();
			expect(useWorkspaceConfigStore.getState().icons).toEqual({});
			expect(useWorkspaceConfigStore.getState().scriptaDirReady).toBe(false);
		});
	});
});

describe("toRelativePath", () => {
	it("strips workspace prefix from absolute path", () => {
		expect(toRelativePath("/workspace", "/workspace/file.md")).toBe("file.md");
	});

	it("strips workspace prefix from nested path", () => {
		expect(toRelativePath("/workspace", "/workspace/docs/readme.md")).toBe("docs/readme.md");
	});

	it("returns original path when prefix does not match", () => {
		expect(toRelativePath("/workspace", "/other/file.md")).toBe("/other/file.md");
	});

	it("handles Windows paths", () => {
		expect(toRelativePath("C:\\Users\\test", "C:\\Users\\test\\file.md")).toBe("file.md");
	});

	it("normalizes backslashes to forward slashes in nested Windows paths", () => {
		expect(toRelativePath("C:\\Users\\test", "C:\\Users\\test\\docs\\readme.md")).toBe(
			"docs/readme.md",
		);
	});
});
