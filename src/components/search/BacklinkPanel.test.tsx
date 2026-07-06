import { act, render } from "@testing-library/react";
import { beforeEach, describe, expect, it, type Mock, vi } from "vitest";
import { cancelBacklinkScan } from "../../lib/commands";
import { useBacklinkStore } from "../../stores/backlink";
import { useWorkspaceStore } from "../../stores/workspace";

// scan / reset は store を、cancel は commands を vi.mock する。
// workspace store は本物を使い、bumpFileTreeVersion / bumpContentVersion / activeTabPath を
// 直接操作して effect の依存を駆動する。
const scan = vi.fn<(workspacePath: string, targetFilePath: string) => Promise<void>>(() =>
	Promise.resolve(),
);
const reset = vi.fn<() => void>();

vi.mock("../../stores/backlink", () => ({
	useBacklinkStore: vi.fn(),
}));

vi.mock("../../lib/commands", () => ({
	cancelBacklinkScan: vi.fn().mockResolvedValue(undefined),
}));

const { BacklinkPanel } = await import("./BacklinkPanel");

const mockedUseBacklinkStore = useBacklinkStore as unknown as Mock;
const mockedCancelBacklinkScan = cancelBacklinkScan as Mock;

interface BacklinkStoreSlice {
	backlinks: never[];
	loading: boolean;
	scan: typeof scan;
	reset: typeof reset;
}

const storeState: BacklinkStoreSlice = {
	backlinks: [],
	loading: false,
	scan,
	reset,
};

const WORKSPACE = "/workspace";
const TARGET_A = "/workspace/a.md";
const TARGET_B = "/workspace/b.md";

function setupWorkspace(activeTabPath: string | null): void {
	act(() => {
		useWorkspaceStore.setState({
			workspacePath: WORKSPACE,
			activeTabPath,
			fileTreeVersion: 0,
			contentVersion: 0,
		});
	});
}

function renderPanel(workspacePath = WORKSPACE) {
	return render(<BacklinkPanel workspacePath={workspacePath} onNavigate={vi.fn()} />);
}

describe("BacklinkPanel", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		scan.mockClear();
		reset.mockClear();
		mockedCancelBacklinkScan.mockClear();
		// selector 呼び出しに現在の storeState を渡す。
		mockedUseBacklinkStore.mockImplementation((selector: (s: BacklinkStoreSlice) => unknown) =>
			selector(storeState),
		);
		setupWorkspace(TARGET_A);
	});

	it("mount 時に scan が 1 回呼ばれる", () => {
		renderPanel();
		expect(scan).toHaveBeenCalledTimes(1);
		expect(scan).toHaveBeenCalledWith(WORKSPACE, TARGET_A);
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
		expect(scan).toHaveBeenCalledWith(WORKSPACE, TARGET_A);
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

	it("targetFilePath 変更では即時 scan される", () => {
		renderPanel();
		scan.mockClear();

		act(() => {
			useWorkspaceStore.setState({ activeTabPath: TARGET_B });
		});
		expect(scan).toHaveBeenCalledTimes(1);
		expect(scan).toHaveBeenCalledWith(WORKSPACE, TARGET_B);
	});

	it("workspacePath 変更では即時 scan される", () => {
		const { rerender } = renderPanel();
		scan.mockClear();

		act(() => {
			rerender(<BacklinkPanel workspacePath="/other" onNavigate={vi.fn()} />);
		});
		expect(scan).toHaveBeenCalledTimes(1);
		expect(scan).toHaveBeenCalledWith("/other", TARGET_A);
	});

	it("unmount cleanup で cancelBacklinkScan が呼ばれる", () => {
		const { unmount } = renderPanel();
		mockedCancelBacklinkScan.mockClear();

		act(() => {
			unmount();
		});
		expect(mockedCancelBacklinkScan).toHaveBeenCalled();
	});

	it("activeTabPath が null では version が進んでも scan されない", () => {
		setupWorkspace(null);
		renderPanel();
		expect(reset).toHaveBeenCalled();
		scan.mockClear();

		act(() => {
			useWorkspaceStore.getState().bumpFileTreeVersion();
		});
		act(() => {
			vi.advanceTimersByTime(2000);
		});
		expect(scan).not.toHaveBeenCalled();
		expect(mockedCancelBacklinkScan).not.toHaveBeenCalled();
	});

	it("activeTabPath null 中に version が進んだ場合、復帰後は即時 scan に加えて遅延 scan が 1 回走る", () => {
		setupWorkspace(null);
		renderPanel();
		scan.mockClear();

		act(() => {
			useWorkspaceStore.getState().bumpFileTreeVersion();
		});

		act(() => {
			useWorkspaceStore.setState({ activeTabPath: TARGET_A });
		});
		expect(scan).toHaveBeenCalledTimes(1);

		act(() => {
			vi.advanceTimersByTime(2000);
		});
		expect(scan).toHaveBeenCalledTimes(2);
	});

	it("debounce 発火後の cleanup では cancelBacklinkScan が送られる", () => {
		renderPanel();
		scan.mockClear();

		act(() => {
			useWorkspaceStore.getState().bumpFileTreeVersion();
		});
		act(() => {
			vi.advanceTimersByTime(2000);
		});
		expect(scan).toHaveBeenCalledTimes(1);
		mockedCancelBacklinkScan.mockClear();

		act(() => {
			useWorkspaceStore.getState().bumpFileTreeVersion();
		});
		expect(mockedCancelBacklinkScan).toHaveBeenCalled();
	});

	it("timer 未発火の cleanup では cancelBacklinkScan が送られない", () => {
		renderPanel();
		scan.mockClear();
		mockedCancelBacklinkScan.mockClear();

		act(() => {
			useWorkspaceStore.getState().bumpFileTreeVersion();
		});
		act(() => {
			vi.advanceTimersByTime(1000);
		});
		act(() => {
			useWorkspaceStore.getState().bumpFileTreeVersion();
		});
		expect(mockedCancelBacklinkScan).not.toHaveBeenCalled();

		act(() => {
			vi.advanceTimersByTime(2000);
		});
		expect(scan).toHaveBeenCalledTimes(1);
	});
});
