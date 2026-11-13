import type { BrowserWindow } from "electron";

export const CLOSE_REQUEST_CHANNEL = "window:close-requested";
export const CLOSE_REQUEST_ACK_CHANNEL = "window:close-requested-ack";
export const CLOSE_REQUEST_TIMEOUT_MS = 10_000;

// renderer の一括保存 (AppLayout の onWindowCloseRequested) が終わるまで close を止める。
// ack が true なら閉じる。保存に失敗したと返ってきたら、破棄して閉じるかを user に
// 尋ねる: 書けない状態が続くと、黙って止めるだけでは閉じる手段が無くなる。外部変更の
// 確認待ち ("conflict") は renderer が自分のダイアログを出しているので、開いたままにする。
// renderer が応答しない (timeout) か落ちているときは閉じる: ウィンドウを閉じられなく
// なる方が、未保存の内容を失うより重いと判断した (#727)。
//
// app.quit() は close を止めたウィンドウが 1 つでもあると quit ごと取り消すので、
// quit 中に止めたウィンドウを許可したら quit を呼び直す (win.close() だけでは
// macOS でウィンドウが消えてアプリが残る)。
interface WindowCloseState {
	win: BrowserWindow;
	// 応答待ちと破棄の確認中の両方で立てておき、その間の close で要求を重ねない。
	pendingRequestId: number | null;
	timer: ReturnType<typeof setTimeout> | null;
	allowClose: boolean;
}

interface CloseGuardDeps {
	quit: () => void;
	confirmDiscard: (win: BrowserWindow) => Promise<boolean>;
}

interface CloseGuard {
	attach: (win: BrowserWindow) => void;
	handleAck: (senderId: number, requestId: unknown, ok: unknown, veto: unknown) => void;
	markQuitting: () => void;
}

export function createCloseGuard(deps: CloseGuardDeps): CloseGuard {
	const states = new Map<number, WindowCloseState>();
	let nextRequestId = 1;
	let quitting = false;

	const clearTimer = (state: WindowCloseState): void => {
		if (state.timer !== null) clearTimeout(state.timer);
		state.timer = null;
	};

	const settle = (state: WindowCloseState, requestId: number, close: boolean): void => {
		if (state.pendingRequestId !== requestId) return;
		clearTimer(state);
		state.pendingRequestId = null;
		if (!close) {
			quitting = false;
			return;
		}
		state.allowClose = true;
		if (quitting) deps.quit();
		else state.win.close();
	};

	const askDiscard = (state: WindowCloseState, requestId: number): void => {
		if (state.pendingRequestId !== requestId) return;
		clearTimer(state);
		deps.confirmDiscard(state.win).then(
			(discard) => settle(state, requestId, discard),
			(error) => {
				console.error("[close-guard] failed to ask whether to discard:", error);
				settle(state, requestId, false);
			},
		);
	};

	return {
		attach(win: BrowserWindow): void {
			const senderId = win.webContents.id;
			const state: WindowCloseState = {
				win,
				pendingRequestId: null,
				timer: null,
				allowClose: false,
			};
			states.set(senderId, state);

			win.on("close", (event) => {
				if (state.allowClose) return;
				event.preventDefault();
				if (state.pendingRequestId !== null) return;
				const requestId = nextRequestId++;
				state.pendingRequestId = requestId;
				state.timer = setTimeout(() => {
					console.error("[close-guard] renderer did not answer the close request in time");
					settle(state, requestId, true);
				}, CLOSE_REQUEST_TIMEOUT_MS);
				win.webContents.send(CLOSE_REQUEST_CHANNEL, requestId);
			});

			win.webContents.on("render-process-gone", () => {
				if (state.pendingRequestId !== null) settle(state, state.pendingRequestId, true);
				else state.allowClose = true;
			});

			win.on("closed", () => {
				clearTimer(state);
				states.delete(senderId);
			});
		},

		handleAck(senderId: number, requestId: unknown, ok: unknown, veto: unknown): void {
			const state = states.get(senderId);
			if (!state || typeof requestId !== "number") return;
			if (ok === true) settle(state, requestId, true);
			else if (veto === "conflict") settle(state, requestId, false);
			else askDiscard(state, requestId);
		},

		markQuitting(): void {
			quitting = true;
		},
	};
}
