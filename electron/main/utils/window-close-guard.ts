import type { BrowserWindow } from "electron";

export const CLOSE_REQUEST_CHANNEL = "window:close-requested";
export const CLOSE_REQUEST_ACK_CHANNEL = "window:close-requested-ack";
export const CLOSE_REQUEST_TIMEOUT_MS = 10_000;

// renderer の一括保存 (AppLayout の onWindowCloseRequested) が終わるまで close を止める。
// ack が true なら閉じ、false なら開いたままにする。renderer が応答しない (timeout) か
// 落ちているときは閉じる: ウィンドウを閉じられなくなる方が、未保存の内容を失うより重い
// と判断した (#727)。
//
// app.quit() は close を止めたウィンドウが 1 つでもあると quit ごと取り消すので、
// quit 中に止めたウィンドウを許可したら quit を呼び直す (win.close() だけでは
// macOS でウィンドウが消えてアプリが残る)。
export interface CloseGuardDeps {
	quit: () => void;
	timeoutMs?: number;
}

export interface CloseGuard {
	attach: (win: BrowserWindow) => void;
	handleAck: (senderId: number, requestId: unknown, ok: unknown) => void;
	markQuitting: () => void;
}

interface WindowCloseState {
	win: BrowserWindow;
	pendingRequestId: number | null;
	timer: ReturnType<typeof setTimeout> | null;
	allowClose: boolean;
	rendererGone: boolean;
}

export function createCloseGuard(deps: CloseGuardDeps): CloseGuard {
	const timeoutMs = deps.timeoutMs ?? CLOSE_REQUEST_TIMEOUT_MS;
	const states = new Map<number, WindowCloseState>();
	let nextRequestId = 1;
	let quitting = false;

	const finish = (state: WindowCloseState, requestId: number, ok: boolean): void => {
		if (state.pendingRequestId !== requestId) return;
		if (state.timer !== null) clearTimeout(state.timer);
		state.timer = null;
		state.pendingRequestId = null;
		if (!ok) {
			quitting = false;
			return;
		}
		state.allowClose = true;
		if (quitting) deps.quit();
		else state.win.close();
	};

	const attach = (win: BrowserWindow): void => {
		const senderId = win.webContents.id;
		const state: WindowCloseState = {
			win,
			pendingRequestId: null,
			timer: null,
			allowClose: false,
			rendererGone: false,
		};
		states.set(senderId, state);

		win.on("close", (event) => {
			if (state.allowClose || state.rendererGone) return;
			event.preventDefault();
			if (state.pendingRequestId !== null) return;
			const requestId = nextRequestId++;
			state.pendingRequestId = requestId;
			state.timer = setTimeout(() => {
				console.error("[close-guard] renderer did not answer the close request in time");
				finish(state, requestId, true);
			}, timeoutMs);
			win.webContents.send(CLOSE_REQUEST_CHANNEL, requestId);
		});

		win.webContents.on("render-process-gone", () => {
			state.rendererGone = true;
			if (state.pendingRequestId !== null) finish(state, state.pendingRequestId, true);
		});

		win.on("closed", () => {
			if (state.timer !== null) clearTimeout(state.timer);
			states.delete(senderId);
		});
	};

	const handleAck = (senderId: number, requestId: unknown, ok: unknown): void => {
		const state = states.get(senderId);
		if (!state || typeof requestId !== "number") return;
		finish(state, requestId, ok === true);
	};

	const markQuitting = (): void => {
		quitting = true;
	};

	return { attach, handleAck, markQuitting };
}
