import { act, render } from "@testing-library/react";
import { beforeEach, describe, expect, it, type Mock, vi } from "vitest";
import { cancelWikilinkScan } from "../../lib/commands";
import { useWikilinkStore } from "../../stores/wikilink";
import { useWorkspaceStore } from "../../stores/workspace";

// scan は store を、cancel は commands を vi.mock する。
// workspace store は本物を使い、bumpFileTreeVersion / bumpContentVersion を直接操作して
// effect の依存を駆動する。
const scan = vi.fn<(workspacePath: string) => Promise<void>>(() => Promise.resolve());

vi.mock("../../stores/wikilink", () => ({
	useWikilinkStore: vi.fn(),
}));

vi.mock("../../lib/commands", () => ({
	cancelWikilinkScan: vi.fn().mockResolvedValue(undefined),
}));

const { UnresolvedLinksPanel } = await import("./UnresolvedLinksPanel");

const mockedUseWikilinkStore = useWikilinkStore as unknown as Mock;
const mockedCancelWikilinkScan = cancelWikilinkScan as Mock;

interface WikilinkStoreSlice {
	unresolvedLinks: never[];
	loading: boolean;
	sortBy: "name" | "count";
	scan: typeof scan;
	setSortBy: () => void;
	setCreateTarget: () => void;
}

const storeState: WikilinkStoreSlice = {
	unresolvedLinks: [],
	loading: false,
	sortBy: "name",
	scan,
	setSortBy: vi.fn(),
	setCreateTarget: vi.fn(),
};

const WORKSPACE = "/workspace";

function setupWorkspace(): void {
	act(() => {
		useWorkspaceStore.setState({
			workspacePath: WORKSPACE,
			fileTreeVersion: 0,
			contentVersion: 0,
		});
	});
}

function renderPanel(workspacePath = WORKSPACE) {
	return render(<UnresolvedLinksPanel workspacePath={workspacePath} onNavigate={vi.fn()} />);
}

describe("UnresolvedLinksPanel", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		scan.mockClear();
		mockedCancelWikilinkScan.mockClear();
		mockedUseWikilinkStore.mockImplementation((selector: (s: WikilinkStoreSlice) => unknown) =>
			selector(storeState),
		);
		setupWorkspace();
	});

	it("mount 時に scan が 1 回呼ばれる", () => {
		renderPanel();
		expect(scan).toHaveBeenCalledTimes(1);
		expect(scan).toHaveBeenCalledWith(WORKSPACE);
	});

	it("bumpFileTreeVersion 後、即時には scan されず 2000ms 経過で 1 回だけ scan される", () => {
		renderPanel();
		scan.mockClear();

		act(() => {
			useWorkspaceStore.getState().bumpFileTreeVersion();
		});
		expect(scan).not.toHaveBeenCalled();

		act(() => {
			vi.advanceTimersByTime(1999);
		});
		expect(scan).not.toHaveBeenCalled();

		act(() => {
			vi.advanceTimersByTime(1);
		});
		expect(scan).toHaveBeenCalledTimes(1);
		expect(scan).toHaveBeenCalledWith(WORKSPACE);
	});

	it("fileTreeVersion と contentVersion が近接発火しても scan は合計 1 回 (debounce 統合)", () => {
		renderPanel();
		scan.mockClear();

		act(() => {
			useWorkspaceStore.getState().bumpFileTreeVersion();
			useWorkspaceStore.getState().bumpContentVersion();
		});
		expect(scan).not.toHaveBeenCalled();

		act(() => {
			vi.advanceTimersByTime(2000);
		});
		expect(scan).toHaveBeenCalledTimes(1);
	});

	it("workspacePath 変更では即時 scan される", () => {
		const { rerender } = renderPanel();
		scan.mockClear();

		act(() => {
			rerender(<UnresolvedLinksPanel workspacePath="/other" onNavigate={vi.fn()} />);
		});
		expect(scan).toHaveBeenCalledTimes(1);
		expect(scan).toHaveBeenCalledWith("/other");
	});

	it("unmount cleanup で cancelWikilinkScan が呼ばれる", () => {
		const { unmount } = renderPanel();
		mockedCancelWikilinkScan.mockClear();

		act(() => {
			unmount();
		});
		expect(mockedCancelWikilinkScan).toHaveBeenCalled();
	});

	it("debounce 発火後の cleanup では cancelWikilinkScan が送られる", () => {
		renderPanel();
		scan.mockClear();

		act(() => {
			useWorkspaceStore.getState().bumpFileTreeVersion();
		});
		act(() => {
			vi.advanceTimersByTime(2000);
		});
		expect(scan).toHaveBeenCalledTimes(1);
		mockedCancelWikilinkScan.mockClear();

		act(() => {
			useWorkspaceStore.getState().bumpFileTreeVersion();
		});
		expect(mockedCancelWikilinkScan).toHaveBeenCalled();
	});

	it("timer 未発火の cleanup では cancelWikilinkScan が送られない", () => {
		renderPanel();
		scan.mockClear();
		mockedCancelWikilinkScan.mockClear();

		act(() => {
			useWorkspaceStore.getState().bumpFileTreeVersion();
		});
		act(() => {
			vi.advanceTimersByTime(1000);
		});
		act(() => {
			useWorkspaceStore.getState().bumpFileTreeVersion();
		});
		expect(mockedCancelWikilinkScan).not.toHaveBeenCalled();

		act(() => {
			vi.advanceTimersByTime(2000);
		});
		expect(scan).toHaveBeenCalledTimes(1);
	});
});
