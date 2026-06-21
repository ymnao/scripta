// @vitest-environment node
import type { Session } from "electron";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	installMainSessionPermissionHandlers,
	installPermissionDenyHandlers,
} from "./permission-handler";

type RequestHandler = Parameters<Session["setPermissionRequestHandler"]>[0];
type CheckHandler = Parameters<Session["setPermissionCheckHandler"]>[0];

// 最小限の Session スタブ。setPermission*Handler で渡された callback を捕捉し、
// テストから直接呼び出して deny / allow の挙動を verify する。
function makeFakeSession(): {
	session: Session;
	getRequestHandler: () => RequestHandler;
	getCheckHandler: () => CheckHandler;
} {
	let requestHandler: RequestHandler | null = null;
	let checkHandler: CheckHandler | null = null;
	const session = {
		setPermissionRequestHandler: vi.fn((h: RequestHandler) => {
			requestHandler = h;
		}),
		setPermissionCheckHandler: vi.fn((h: CheckHandler) => {
			checkHandler = h;
		}),
	} as unknown as Session;
	return {
		session,
		getRequestHandler: () => {
			if (requestHandler === null) throw new Error("request handler not installed");
			return requestHandler;
		},
		getCheckHandler: () => {
			if (checkHandler === null) throw new Error("check handler not installed");
			return checkHandler;
		},
	};
}

describe("installPermissionDenyHandlers (all deny)", () => {
	it("installs both request and check handlers exactly once", () => {
		const { session } = makeFakeSession();
		installPermissionDenyHandlers(session);
		expect(session.setPermissionRequestHandler).toHaveBeenCalledTimes(1);
		expect(session.setPermissionCheckHandler).toHaveBeenCalledTimes(1);
	});

	it("request handler invokes the callback with false for any permission", () => {
		const { session, getRequestHandler } = makeFakeSession();
		installPermissionDenyHandlers(session);
		const handler = getRequestHandler();
		const callback = vi.fn();
		for (const p of ["notifications", "media", "geolocation", "clipboard-read"]) {
			callback.mockClear();
			handler(null as never, p as never, callback, {} as never);
			expect(callback).toHaveBeenCalledWith(false);
		}
	});

	it("check handler always returns false (sync deny)", () => {
		const { session, getCheckHandler } = makeFakeSession();
		installPermissionDenyHandlers(session);
		const handler = getCheckHandler();
		expect(handler(null, "media", "https://example.com", {} as never)).toBe(false);
		expect(handler(null, "clipboard-read", "http://localhost:5173", {} as never)).toBe(false);
	});
});

describe("installMainSessionPermissionHandlers (clipboard allowlist)", () => {
	const original = process.env.ELECTRON_RENDERER_URL;

	beforeEach(() => {
		// dev モードで「信頼 origin = http://localhost:5173」固定
		process.env.ELECTRON_RENDERER_URL = "http://localhost:5173/";
	});

	afterEach(() => {
		if (original === undefined) {
			delete process.env.ELECTRON_RENDERER_URL;
		} else {
			process.env.ELECTRON_RENDERER_URL = original;
		}
	});

	describe("request handler", () => {
		const callRequest = (permission: string, requestingUrl: string): boolean => {
			const { session, getRequestHandler } = makeFakeSession();
			installMainSessionPermissionHandlers(session);
			const handler = getRequestHandler();
			const callback = vi.fn();
			handler(null as never, permission as never, callback, { requestingUrl } as never);
			return callback.mock.calls[0]?.[0] === true;
		};

		it("allows clipboard-read from a trusted origin", () => {
			expect(callRequest("clipboard-read", "http://localhost:5173/index.html")).toBe(true);
		});

		it("allows clipboard-sanitized-write from a trusted origin", () => {
			expect(callRequest("clipboard-sanitized-write", "http://localhost:5173/")).toBe(true);
		});

		it("denies clipboard-read from an untrusted origin", () => {
			expect(callRequest("clipboard-read", "http://evil.example.com/")).toBe(false);
		});

		it("denies other allowlist-misses even from a trusted origin", () => {
			expect(callRequest("media", "http://localhost:5173/")).toBe(false);
			expect(callRequest("notifications", "http://localhost:5173/")).toBe(false);
			expect(callRequest("geolocation", "http://localhost:5173/")).toBe(false);
		});

		it("denies when requestingUrl is missing", () => {
			const { session, getRequestHandler } = makeFakeSession();
			installMainSessionPermissionHandlers(session);
			const callback = vi.fn();
			getRequestHandler()(null as never, "clipboard-read" as never, callback, {} as never);
			expect(callback).toHaveBeenCalledWith(false);
		});
	});

	describe("check handler", () => {
		const call = (permission: string, requestingOrigin: string): boolean => {
			const { session, getCheckHandler } = makeFakeSession();
			installMainSessionPermissionHandlers(session);
			return getCheckHandler()(null, permission, requestingOrigin, {} as never);
		};

		it("returns true for clipboard-read from a trusted origin", () => {
			expect(call("clipboard-read", "http://localhost:5173")).toBe(true);
		});

		it("returns false for clipboard-read from an untrusted origin", () => {
			expect(call("clipboard-read", "http://evil.example.com")).toBe(false);
		});

		it("returns false for non-allowlisted permissions", () => {
			expect(call("media", "http://localhost:5173")).toBe(false);
			expect(call("hid", "http://localhost:5173")).toBe(false);
		});
	});
});
