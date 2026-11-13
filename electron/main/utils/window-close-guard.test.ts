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

const setup = (quit = vi.fn()) => {
	const guard = createCloseGuard({ quit });
	const win = new FakeWindow(1);
	guard.attach(asWindow(win));
	return { guard, win, quit };
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

		guard.handleAck(1, lastRequestId(win), true);

		expect(win.destroyed).toBe(true);
	});

	it("keeps the window open when the renderer acks false, and asks again on the next close", () => {
		const { guard, win } = setup();
		win.close();

		guard.handleAck(1, lastRequestId(win), false);
		expect(win.destroyed).toBe(false);

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
		guard.handleAck(1, first, false);
		win.close();

		guard.handleAck(1, first, true);

		expect(win.destroyed).toBe(false);
	});

	it("ignores an ack sent from another window's renderer", () => {
		const { guard, win } = setup();
		guard.attach(asWindow(new FakeWindow(2)));
		win.close();

		guard.handleAck(2, lastRequestId(win), true);

		expect(win.destroyed).toBe(false);
	});

	it("treats a non-boolean ok as a refusal", () => {
		const { guard, win } = setup();
		win.close();

		guard.handleAck(1, lastRequestId(win), "true");

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
		guard.handleAck(1, lastRequestId(win), false);

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

		guard.handleAck(1, lastRequestId(win), true);

		expect(quit).toHaveBeenCalledTimes(1);
		expect(win.close).toHaveBeenCalledTimes(1);
	});

	it("lets the window close when the resumed quit closes it", () => {
		const { guard, win } = setup();
		guard.markQuitting();
		win.close();
		guard.handleAck(1, lastRequestId(win), true);

		win.close();

		expect(win.webContents.send).toHaveBeenCalledTimes(1);
		expect(win.destroyed).toBe(true);
	});

	it("drops the quit when the renderer refuses, so a later plain close does not quit", () => {
		const { guard, win, quit } = setup();
		guard.markQuitting();
		win.close();
		guard.handleAck(1, lastRequestId(win), false);

		win.close();
		guard.handleAck(1, lastRequestId(win), true);

		expect(quit).not.toHaveBeenCalled();
		expect(win.destroyed).toBe(true);
	});

	it("ignores acks for a window that has already closed", () => {
		const { guard, win } = setup();
		win.close();
		const requestId = lastRequestId(win);
		guard.handleAck(1, requestId, true);

		expect(() => guard.handleAck(1, requestId, true)).not.toThrow();
		expect(win.close).toHaveBeenCalledTimes(2);
	});

	it("drops a pending request when the window is closed from elsewhere", () => {
		const { guard, win } = setup();
		win.close();
		const requestId = lastRequestId(win);
		win.destroyed = true;
		win.emit("closed");

		guard.handleAck(1, requestId, true);
		win.webContents.emit("render-process-gone");
		vi.advanceTimersByTime(CLOSE_REQUEST_TIMEOUT_MS);

		expect(win.close).toHaveBeenCalledTimes(1);
	});
});
