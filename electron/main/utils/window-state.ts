import { type BrowserWindow, type Rectangle, screen } from "electron";

export interface WindowState {
	bounds?: Rectangle;
	isMaximized?: boolean;
	isFullScreen?: boolean;
}

const DEFAULT_BOUNDS: Rectangle = { x: 0, y: 0, width: 1200, height: 800 };
const MIN_WIDTH = 400;
const MIN_HEIGHT = 300;

// 復元 bounds が「どの display の workArea とも 1px も重ならない」場合は不可視扱い。
// ディスプレイを抜いた / 解像度が下がった / マルチモニタ構成が変わった等で
// オフスクリーンに復元するとユーザーが操作不能になるため、必ずデフォルト位置へ
// fallback する。完全格納（全 4 辺が同じ display 内）まで要求するとモニタ跨ぎの
// ウィンドウが弾かれて UX が劣化するので「重なりがあれば可視」とゆるく判定する。
export function isBoundsVisible(bounds: Rectangle): boolean {
	const displays = screen.getAllDisplays();
	return displays.some((d) => {
		const work = d.workArea;
		const x1 = Math.max(bounds.x, work.x);
		const y1 = Math.max(bounds.y, work.y);
		const x2 = Math.min(bounds.x + bounds.width, work.x + work.width);
		const y2 = Math.min(bounds.y + bounds.height, work.y + work.height);
		return x2 > x1 && y2 > y1;
	});
}

function isFiniteRect(b: unknown): b is Rectangle {
	if (typeof b !== "object" || b === null) return false;
	const r = b as Record<string, unknown>;
	return (
		Number.isFinite(r.x) &&
		Number.isFinite(r.y) &&
		Number.isFinite(r.width) &&
		Number.isFinite(r.height)
	);
}

// settings.json は手書き編集や別バージョンで書かれた値が入っていることがある。
// 取り出した値は必ず構造を検証してから使う（NaN bounds で setBounds を呼ぶと
// Electron が throw する → ウィンドウが永久に開かなくなる）。
export function normalizeWindowState(value: unknown): WindowState | null {
	if (typeof value !== "object" || value === null) return null;
	const v = value as Record<string, unknown>;
	const out: WindowState = {};
	if (isFiniteRect(v.bounds)) out.bounds = v.bounds;
	if (typeof v.isMaximized === "boolean") out.isMaximized = v.isMaximized;
	if (typeof v.isFullScreen === "boolean") out.isFullScreen = v.isFullScreen;
	return out;
}

export interface InitialWindowGeometry {
	bounds: Rectangle;
	maximize: boolean;
	fullScreen: boolean;
}

export function resolveInitialGeometry(state: WindowState | null): InitialWindowGeometry {
	if (!state?.bounds) {
		return { bounds: DEFAULT_BOUNDS, maximize: false, fullScreen: false };
	}
	const b = state.bounds;
	if (b.width < MIN_WIDTH || b.height < MIN_HEIGHT || !isBoundsVisible(b)) {
		// bounds は壊れているがフラグは尊重する（復元 display が無いだけで、
		// 「最大化で起動したい」というユーザー意図は保持する）
		return {
			bounds: DEFAULT_BOUNDS,
			maximize: state.isMaximized === true,
			fullScreen: state.isFullScreen === true,
		};
	}
	return {
		bounds: b,
		maximize: state.isMaximized === true,
		fullScreen: state.isFullScreen === true,
	};
}

export interface AttachOptions {
	saveAsync: (state: WindowState) => void;
	saveSync: (state: WindowState) => void;
	debounceMs?: number;
}

// resize / move は debounced async 書き込み、close は同期書き込みにする。
// async のままだと close ハンドラから fire-and-forget で書いた writeFileAtomic が
// プロセス終了に間に合わず、最後の状態が永続化されないことがある。
// 同期 writeFileAtomic.sync は tmp → fsync → rename を sync で完了させる。
export function attachWindowStateTracker(win: BrowserWindow, opts: AttachOptions): () => void {
	const debounce = opts.debounceMs ?? 500;
	let timer: NodeJS.Timeout | null = null;

	const captureState = (): WindowState => ({
		// getNormalBounds は最大化 / 全画面状態でも「通常時の」bounds を返す。
		// getBounds だと最大化中の display 全面サイズが保存され、unmaximize 時の
		// 復元位置を失う。
		bounds: win.getNormalBounds(),
		isMaximized: win.isMaximized(),
		isFullScreen: win.isFullScreen(),
	});

	const flushAsync = (): void => {
		timer = null;
		if (win.isDestroyed()) return;
		try {
			opts.saveAsync(captureState());
		} catch (e) {
			console.warn("[window-state] saveAsync failed:", e);
		}
	};

	const schedule = (): void => {
		if (timer !== null) clearTimeout(timer);
		timer = setTimeout(flushAsync, debounce);
	};

	const flushSyncOnClose = (): void => {
		if (timer !== null) {
			clearTimeout(timer);
			timer = null;
		}
		if (win.isDestroyed()) return;
		try {
			opts.saveSync(captureState());
		} catch (e) {
			console.warn("[window-state] saveSync failed:", e);
		}
	};

	win.on("resize", schedule);
	win.on("move", schedule);
	win.on("maximize", schedule);
	win.on("unmaximize", schedule);
	win.on("enter-full-screen", schedule);
	win.on("leave-full-screen", schedule);
	// 'close' は close 確定前に発火するため getNormalBounds が有効。
	// 'closed' まで待つと getBounds 系 API がすでに無効になっている。
	win.on("close", flushSyncOnClose);

	return () => {
		if (timer !== null) {
			clearTimeout(timer);
			timer = null;
		}
	};
}

export const __testing = {
	DEFAULT_BOUNDS,
	MIN_WIDTH,
	MIN_HEIGHT,
};
