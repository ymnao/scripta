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
	it("cancelFilenameSearch の完了を await してから workspaceSet を呼ぶ (順序 + await load-bearing)", async () => {
		(window.api.openDirectoryPicker as Mock).mockResolvedValueOnce("/new/workspace");

		// cancel を deferred にして「resolve 前は workspaceSet 未呼び出し」を pin する。
		// この deferred が無いと `await` を `void` に退行させても呼び出し順は不変で緑になる。
		let resolveCancel: (() => void) | null = null;
		(window.api.cancelFilenameSearch as Mock).mockImplementationOnce(
			() =>
				new Promise<void>((resolve) => {
					resolveCancel = resolve;
				}),
		);

		renderSidebar();
		fireEvent.click(screen.getByLabelText("フォルダを開く"));

		// picker + cancel の invoke までは進むが、cancel が pending の間 workspaceSet は呼ばれない
		await vi.waitFor(() => {
			expect(window.api.cancelFilenameSearch).toHaveBeenCalledTimes(1);
		});
		expect(window.api.workspaceSet).not.toHaveBeenCalled();

		// cancel を resolve すると workspaceSet が続く
		resolveCancel?.();
		await vi.waitFor(() => {
			expect(window.api.workspaceSet).toHaveBeenCalledWith("/new/workspace");
		});
	});

	it("workspaceSet が reject しても cancelFilenameSearch は 1 回呼ばれ済み (catch 分岐カバー)", async () => {
		(window.api.openDirectoryPicker as Mock).mockResolvedValueOnce("/new/workspace");
		(window.api.workspaceSet as Mock).mockRejectedValueOnce(new Error("permission denied"));

		renderSidebar();
		fireEvent.click(screen.getByLabelText("フォルダを開く"));

		// workspaceSet が呼ばれた時点で cancel は 1 回呼び出し済み。
		// 順序 (cancel が workspaceSet より先) は前段の deferred pin テストで保証しており、
		// ここは catch 分岐に入っても両方が呼ばれる回数だけを assert する。
		await vi.waitFor(() => {
			expect(window.api.workspaceSet).toHaveBeenCalledTimes(1);
		});
		expect(window.api.cancelFilenameSearch).toHaveBeenCalledTimes(1);
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
