// @vitest-environment node
import type { Session } from "electron";
import { describe, expect, it, vi } from "vitest";
import { installPermissionDenyHandlers } from "./permission-handler";

// 最小限の Session スタブ。`setPermissionRequestHandler` / `setPermissionCheckHandler`
// だけが呼ばれることを確認し、それぞれの callback / 戻り値が常に false である
// （= 何も許可しない）ことを verify する。
function makeFakeSession(): {
	session: Session;
	getRequestHandler: () => Parameters<Session["setPermissionRequestHandler"]>[0];
	getCheckHandler: () => Parameters<Session["setPermissionCheckHandler"]>[0];
} {
	let requestHandler: Parameters<Session["setPermissionRequestHandler"]>[0] | null = null;
	let checkHandler: Parameters<Session["setPermissionCheckHandler"]>[0] | null = null;
	const session = {
		setPermissionRequestHandler: vi.fn(
			(h: Parameters<Session["setPermissionRequestHandler"]>[0]) => {
				requestHandler = h;
			},
		),
		setPermissionCheckHandler: vi.fn((h: Parameters<Session["setPermissionCheckHandler"]>[0]) => {
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

describe("installPermissionDenyHandlers", () => {
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
		// 代表的な permission 名を流して全部 deny されることを確認
		const permissions = ["notifications", "media", "geolocation", "clipboard-read"];
		for (const p of permissions) {
			callback.mockClear();
			// _webContents の型は厳密だが本テストでは未使用なのでダミーを渡す
			handler(null as never, p as never, callback, {} as never);
			expect(callback).toHaveBeenCalledTimes(1);
			expect(callback).toHaveBeenCalledWith(false);
		}
	});

	it("check handler always returns false (sync deny)", () => {
		const { session, getCheckHandler } = makeFakeSession();
		installPermissionDenyHandlers(session);
		const handler = getCheckHandler();
		expect(handler(null, "media", "https://example.com", {} as never)).toBe(false);
		expect(handler(null, "geolocation", "file:///", {} as never)).toBe(false);
	});
});
