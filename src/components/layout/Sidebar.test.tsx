import { fireEvent, render, screen } from "@testing-library/react";
import type { Mock } from "vitest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useWorkspaceStore } from "../../stores/workspace";
import { Sidebar } from "./Sidebar";

// zustand ストアはテスト間で保持されるため、各テスト前に workspacePath を null にリセットして
// Sidebar が空状態 (「フォルダを開く」ボタン) を描画する状態から始める。
beforeEach(() => {
	useWorkspaceStore.setState({ workspacePath: null, activeTabPath: null });
});

// FileTree / 検索系子コンポーネントは workspace が set された時のみ描画されるので、
// このテストでは workspacePath=null の空状態から「フォルダを開く」ボタンを押す経路のみを検証する。
// FileTree などを本物で render すると listDirectory 等の IPC 呼び出しが増えてノイズになるため。

function renderSidebar() {
	const noop = () => {};
	return render(
		<Sidebar
			activePanel="files"
			onShowFiles={noop}
			onShowSearch={noop}
			onShowUnresolved={noop}
			onShowBacklink={noop}
			onSearchNavigate={noop}
			onFileSelect={noop}
			onFileOpenNewTab={noop}
		/>,
	);
}

describe("Sidebar handleOpenFolder", () => {
	it("cancelFilenameSearch を workspaceSet より前に呼ぶ (workspace 切替入口の in-flight bail)", async () => {
		(window.api.openDirectoryPicker as Mock).mockResolvedValueOnce("/new/workspace");

		const callOrder: string[] = [];
		(window.api.cancelFilenameSearch as Mock).mockImplementationOnce(async () => {
			callOrder.push("cancelFilenameSearch");
		});
		(window.api.workspaceSet as Mock).mockImplementationOnce(async () => {
			callOrder.push("workspaceSet");
		});

		renderSidebar();
		fireEvent.click(screen.getByLabelText("フォルダを開く"));

		// picker → cancel → workspaceSet の順を待つ
		await vi.waitFor(() => {
			expect(callOrder).toEqual(["cancelFilenameSearch", "workspaceSet"]);
		});
	});

	it("cancelFilenameSearch が reject しても workspaceSet は継続する (cancel は best-effort)", async () => {
		(window.api.openDirectoryPicker as Mock).mockResolvedValueOnce("/new/workspace");
		(window.api.cancelFilenameSearch as Mock).mockRejectedValueOnce(new Error("IPC down"));

		renderSidebar();
		fireEvent.click(screen.getByLabelText("フォルダを開く"));

		await vi.waitFor(() => {
			expect(window.api.workspaceSet).toHaveBeenCalledWith("/new/workspace");
		});
	});

	it("picker が null を返した場合は cancelFilenameSearch を呼ばない (切替が起きない = 巻き込み semantic 未発火)", async () => {
		(window.api.openDirectoryPicker as Mock).mockResolvedValueOnce(null);

		renderSidebar();
		fireEvent.click(screen.getByLabelText("フォルダを開く"));

		// picker 解決を待ってから確認
		await vi.waitFor(() => {
			expect(window.api.openDirectoryPicker).toHaveBeenCalled();
		});
		expect(window.api.cancelFilenameSearch).not.toHaveBeenCalled();
		expect(window.api.workspaceSet).not.toHaveBeenCalled();
	});
});
