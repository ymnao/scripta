import { beforeEach, describe, expect, it } from "vitest";
import { useWorkspaceStore } from "./workspace";

describe("useWorkspaceStore", () => {
	beforeEach(() => {
		useWorkspaceStore.setState({
			workspacePath: null,
			openFilePath: null,
		});
	});

	it("has null initial state", () => {
		const state = useWorkspaceStore.getState();
		expect(state.workspacePath).toBeNull();
		expect(state.openFilePath).toBeNull();
	});

	it("sets workspace path and resets open file", () => {
		const { setOpenFilePath, setWorkspacePath } = useWorkspaceStore.getState();
		setOpenFilePath("/old/file.md");
		setWorkspacePath("/new/workspace");

		const state = useWorkspaceStore.getState();
		expect(state.workspacePath).toBe("/new/workspace");
		expect(state.openFilePath).toBeNull();
	});

	it("sets open file path", () => {
		const { setOpenFilePath } = useWorkspaceStore.getState();
		setOpenFilePath("/workspace/note.md");

		expect(useWorkspaceStore.getState().openFilePath).toBe("/workspace/note.md");
	});

	it("clears workspace path", () => {
		const { setWorkspacePath } = useWorkspaceStore.getState();
		setWorkspacePath("/workspace");
		setWorkspacePath(null);

		const state = useWorkspaceStore.getState();
		expect(state.workspacePath).toBeNull();
		expect(state.openFilePath).toBeNull();
	});
});
