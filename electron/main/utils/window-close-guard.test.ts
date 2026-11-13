// @vitest-environment node
import { EventEmitter } from "node:events";
import type { BrowserWindow } from "electron";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	CLOSE_REQUEST_CHANNEL,
	CLOSE_REQUEST_TIMEOUT_MS,
	createCloseGuard,
} from "./window-close-guard";

class FakeWebContents extends EventEmitter {
	send = vi.fn();
	readonly id: number;
	constructor(id: number) {
		super();
		this.id = id;
	}
}

class FakeWindow extends EventEmitter {
	readonly webContents: FakeWebContents;
	destroyed = false;
	constructor(id: number) {
		super();
		this.webContents = new FakeWebContents(id);
	}
	// 実 BrowserWindow と同じく、close は "close" で止められなければ "closed" まで進む。
	close = vi.fn(() => {
		if (this.destroyed) return;
		let prevented = false;
		this.emit("close", {
			preventDefault: () => {
				prevented = true;
			},
		});
		if (prevented) return;
		this.destroyed = true;
		this.emit("closed");
	});
}

const asWindow = (w: FakeWindow): BrowserWindow => w as unknown as BrowserWindow;

const lastRequestId = (w: FakeWindow): number => {
	const call = w.webContents.send.mock.calls.at(-1);
	if (!call) throw new Error("no close request was sent");
	expect(call[0]).toBe(CLOSE_REQUEST_CHANNEL);
	return call[1] as number;
};

const setup = (confirmDiscard = vi.fn(async () => false)) => {
	const quit = vi.fn();
	const guard = createCloseGuard({ quit, confirmDiscard });
	const win = new FakeWindow(1);
	guard.attach(asWindow(win));
	return { guard, win, quit, confirmDiscard };
};

beforeEach(() => {
	vi.useFakeTimers();
	vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
});

describe("createCloseGuard", () => {
	it("holds the close and asks the renderer instead of closing", () => {
		const { win } = setup();

		win.close();

		expect(win.destroyed).toBe(false);
		expect(win.webContents.send).toHaveBeenCalledTimes(1);
		expect(win.webContents.send).toHaveBeenCalledWith(CLOSE_REQUEST_CHANNEL, expect.any(Number));
	});

	it("closes the window when the renderer acks true", () => {
		const { guard, win } = setup();
		win.close();

		guard.handleAck(1, lastRequestId(win), true, undefined);

		expect(win.destroyed).toBe(true);
	});

	it("keeps the window open on a conflict veto without asking to discard, and asks again on the next close", () => {
		const { guard, win, confirmDiscard } = setup();
		win.close();

		guard.handleAck(1, lastRequestId(win), false, "conflict");
		expect(win.destroyed).toBe(false);
		expect(confirmDiscard).not.toHaveBeenCalled();

		win.close();
		expect(win.webContents.send).toHaveBeenCalledTimes(2);
		expect(win.destroyed).toBe(false);
	});

	it("does not send a second request while one is pending", () => {
		const { win } = setup();

		win.close();
		win.close();

		expect(win.webContents.send).toHaveBeenCalledTimes(1);
		expect(win.destroyed).toBe(false);
	});

	it("ignores an ack with a stale request id", () => {
		const { guard, win } = setup();
		win.close();
		const first = lastRequestId(win);
		guard.handleAck(1, first, false, "conflict");
		win.close();

		guard.handleAck(1, first, true, undefined);

		expect(win.destroyed).toBe(false);
	});

	it("ignores an ack sent from another window's renderer", () => {
		const { guard, win } = setup();
		guard.attach(asWindow(new FakeWindow(2)));
		win.close();

		guard.handleAck(2, lastRequestId(win), true, undefined);

		expect(win.destroyed).toBe(false);
	});

	it("does not treat a non-boolean ok as permission to close", () => {
		const { guard, win } = setup();
		win.close();

		guard.handleAck(1, lastRequestId(win), "true", "conflict");

		expect(win.destroyed).toBe(false);
	});

	it("asks whether to discard on a save-failed veto, and keeps the window when declined", async () => {
		const { guard, win, confirmDiscard } = setup();
		win.close();

		guard.handleAck(1, lastRequestId(win), false, "save-failed");
		// 確認が決着するまでの close は無視されるので、届くまで close し直す。
		await vi.waitFor(() => {
			win.close();
			expect(win.webContents.send).toHaveBeenCalledTimes(2);
		});

		expect(confirmDiscard).toHaveBeenCalledWith(win);
		expect(win.destroyed).toBe(false);
	});

	it("closes the window when the user chooses to discard", async () => {
		const { guard, win } = setup(vi.fn(async () => true));
		win.close();

		guard.handleAck(1, lastRequestId(win), false, "save-failed");

		await vi.waitFor(() => expect(win.destroyed).toBe(true));
	});

	it("asks whether to discard when the veto is unknown", async () => {
		const { guard, win, confirmDiscard } = setup();
		win.close();

		guard.handleAck(1, lastRequestId(win), false, undefined);

		await vi.waitFor(() => expect(confirmDiscard).toHaveBeenCalledTimes(1));
	});

	it("resumes the quit when the user chooses to discard during a quit", async () => {
		const { guard, win, quit } = setup(vi.fn(async () => true));
		guard.markQuitting();
		win.close();

		guard.handleAck(1, lastRequestId(win), false, "save-failed");

		await vi.waitFor(() => expect(quit).toHaveBeenCalledTimes(1));
	});

	it("does not send another request or close on timeout while the user is deciding", async () => {
		let answer!: (discard: boolean) => void;
		const { guard, win } = setup(
			vi.fn(
				() =>
					new Promise<boolean>((resolve) => {
						answer = resolve;
					}),
			),
		);
		win.close();
		guard.handleAck(1, lastRequestId(win), false, "save-failed");

		win.close();
		vi.advanceTimersByTime(CLOSE_REQUEST_TIMEOUT_MS);

		expect(win.webContents.send).toHaveBeenCalledTimes(1);
		expect(win.destroyed).toBe(false);
		answer(true);
		await vi.waitFor(() => expect(win.destroyed).toBe(true));
	});

	it("keeps the window open when the discard dialog fails", async () => {
		const { guard, win } = setup(vi.fn(async () => Promise.reject(new Error("no dialog"))));
		win.close();

		guard.handleAck(1, lastRequestId(win), false, "save-failed");
		await vi.waitFor(() => {
			win.close();
			expect(win.webContents.send).toHaveBeenCalledTimes(2);
		});

		expect(win.destroyed).toBe(false);
	});

	it("closes the window when the renderer does not answer in time", () => {
		const { win } = setup();
		win.close();

		vi.advanceTimersByTime(CLOSE_REQUEST_TIMEOUT_MS - 1);
		expect(win.destroyed).toBe(false);
		vi.advanceTimersByTime(1);
		expect(win.destroyed).toBe(true);
	});

	it("does not fire the timeout after the renderer has answered", () => {
		const { guard, win } = setup();
		win.close();
		guard.handleAck(1, lastRequestId(win), false, "conflict");

		vi.advanceTimersByTime(CLOSE_REQUEST_TIMEOUT_MS);

		expect(win.destroyed).toBe(false);
	});

	it("closes a pending window when its renderer process goes away", () => {
		const { win } = setup();
		win.close();

		win.webContents.emit("render-process-gone");

		expect(win.destroyed).toBe(true);
	});

	it("closes without asking once the renderer process has gone", () => {
		const { win } = setup();
		win.webContents.emit("render-process-gone");

		win.close();

		expect(win.webContents.send).not.toHaveBeenCalled();
		expect(win.destroyed).toBe(true);
	});

	it("resumes the quit instead of closing the window when the close came from a quit", () => {
		const { guard, win, quit } = setup();
		guard.markQuitting();
		win.close();

		guard.handleAck(1, lastRequestId(win), true, undefined);

		expect(quit).toHaveBeenCalledTimes(1);
		expect(win.close).toHaveBeenCalledTimes(1);
	});

	it("lets the window close when the resumed quit closes it", () => {
		const { guard, win } = setup();
		guard.markQuitting();
		win.close();
		guard.handleAck(1, lastRequestId(win), true, undefined);

		win.close();

		expect(win.webContents.send).toHaveBeenCalledTimes(1);
		expect(win.destroyed).toBe(true);
	});

	it("drops the quit on a conflict veto, so a later plain close does not quit", () => {
		const { guard, win, quit } = setup();
		guard.markQuitting();
		win.close();
		guard.handleAck(1, lastRequestId(win), false, "conflict");

		win.close();
		guard.handleAck(1, lastRequestId(win), true, undefined);

		expect(quit).not.toHaveBeenCalled();
		expect(win.destroyed).toBe(true);
	});

	it("ignores acks for a window that has already closed", () => {
		const { guard, win } = setup();
		win.close();
		const requestId = lastRequestId(win);
		guard.handleAck(1, requestId, true, undefined);

		expect(() => guard.handleAck(1, requestId, true, undefined)).not.toThrow();
		expect(win.close).toHaveBeenCalledTimes(2);
	});
});
