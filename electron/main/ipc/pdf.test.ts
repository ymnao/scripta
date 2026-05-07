// @vitest-environment node
import { promises as fsp } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// `new BrowserWindow(opts)` の捕捉と printToPDF / loadFile / executeJavaScript の
// 振る舞いを差し替え可能にする mock。window.test.ts と同じ Proxy + vi.hoisted の
// パターン。
type FakeWindow = {
	webContents: {
		id: number;
		printToPDF: ReturnType<typeof vi.fn>;
		executeJavaScript: ReturnType<typeof vi.fn>;
	};
	loadFile: ReturnType<typeof vi.fn>;
	isDestroyed: ReturnType<typeof vi.fn>;
	destroy: ReturnType<typeof vi.fn>;
	__opts: unknown;
};

const { createdWindows, createFakeWindow, simulateState } = vi.hoisted(() => {
	const list: FakeWindow[] = [];
	let nextId = 5000;
	const state = {
		printToPdfImpl: undefined as ((opts: unknown) => Promise<Buffer>) | undefined,
		loadFileShouldHang: false,
	};
	const create = (opts: unknown): FakeWindow => {
		const id = nextId++;
		const win: FakeWindow = {
			webContents: {
				id,
				printToPDF: vi.fn(async (o) => {
					if (state.printToPdfImpl) return state.printToPdfImpl(o);
					return Buffer.from("%PDF-1.4 fake pdf body\n");
				}),
				executeJavaScript: vi.fn(async () => true),
			},
			loadFile: vi.fn(async () => {
				if (state.loadFileShouldHang) {
					await new Promise(() => {}); // never resolve
				}
			}),
			isDestroyed: vi.fn(() => false),
			destroy: vi.fn(),
			__opts: opts,
		};
		list.push(win);
		return win;
	};
	return { createdWindows: list, createFakeWindow: create, simulateState: state };
});

vi.mock("electron", () => {
	const ProxyTarget = class {};
	const MockBrowserWindow = new Proxy(ProxyTarget, {
		construct(_t, args) {
			return createFakeWindow(args[0]) as unknown as object;
		},
		get() {
			return undefined;
		},
	});
	const fakeSession = {
		webRequest: {
			onBeforeRequest: vi.fn(),
		},
	};
	return {
		BrowserWindow: MockBrowserWindow,
		ipcMain: { handle: vi.fn() },
		session: { fromPartition: vi.fn(() => fakeSession) },
	};
});

import {
	clearWorkspaceRoots,
	registerTransientWritePath,
	registerWorkspaceRoot,
} from "../utils/path-guard";
import { __testing } from "./pdf";

const { exportPdfImpl, shouldAllowPdfRequest } = __testing;

const SENDER_ID = 42;

async function makeWorkspaceTmp(): Promise<string> {
	const dir = await fsp.mkdtemp(join(tmpdir(), "scripta-pdf-test-"));
	return await fsp.realpath(dir);
}

describe("exportPdfImpl", () => {
	let workspace: string;

	beforeEach(async () => {
		clearWorkspaceRoots();
		createdWindows.length = 0;
		simulateState.printToPdfImpl = undefined;
		simulateState.loadFileShouldHang = false;
		workspace = await makeWorkspaceTmp();
		registerWorkspaceRoot(SENDER_ID, workspace);
	});

	afterEach(async () => {
		clearWorkspaceRoots();
		await fsp.rm(workspace, { recursive: true, force: true }).catch(() => {});
	});

	it("rejects outputPath outside workspace and without transient", async () => {
		const outsidePath = join(tmpdir(), "scripta-pdf-outside.pdf");
		await expect(exportPdfImpl(SENDER_ID, "<html></html>", outsidePath)).rejects.toThrow(
			/Permission denied/,
		);
		// no window should be created in failure case
		expect(createdWindows.length).toBe(0);
	});

	it("writes PDF for path inside workspace", async () => {
		const outputPath = join(workspace, "out.pdf");
		await exportPdfImpl(SENDER_ID, "<html><body>hi</body></html>", outputPath);
		const written = await fsp.readFile(outputPath);
		expect(written.toString("utf8")).toContain("%PDF-1.4");
		// window must be destroyed in finally
		expect(createdWindows[0].destroy).toHaveBeenCalled();
	});

	it("writes PDF for transient (saveDialog) path outside workspace", async () => {
		const transientDir = await makeWorkspaceTmp();
		const transientPath = join(transientDir, "save.pdf");
		registerTransientWritePath(SENDER_ID, transientPath);
		await exportPdfImpl(SENDER_ID, "<html><body>hi</body></html>", transientPath);
		const written = await fsp.readFile(transientPath);
		expect(written.toString("utf8")).toContain("%PDF-1.4");
		await fsp.rm(transientDir, { recursive: true, force: true });
	});

	it("uses dedicated partition (avoids main session CSP injection)", async () => {
		const outputPath = join(workspace, "out2.pdf");
		await exportPdfImpl(SENDER_ID, "<html></html>", outputPath);
		const opts = createdWindows[0].__opts as {
			webPreferences: { partition: string };
		};
		expect(opts.webPreferences.partition).toBe("scripta-pdf-export");
	});

	it("destroys window even if printToPDF throws", async () => {
		simulateState.printToPdfImpl = async () => {
			throw new Error("printToPDF failed");
		};
		const outputPath = join(workspace, "fail.pdf");
		await expect(exportPdfImpl(SENDER_ID, "<html></html>", outputPath)).rejects.toThrow(
			/printToPDF failed/,
		);
		expect(createdWindows[0].destroy).toHaveBeenCalled();
	});

	it("rejects empty PDF buffer", async () => {
		simulateState.printToPdfImpl = async () => Buffer.alloc(0);
		const outputPath = join(workspace, "empty.pdf");
		await expect(exportPdfImpl(SENDER_ID, "<html></html>", outputPath)).rejects.toThrow(
			/PDFファイルが空/,
		);
		expect(createdWindows[0].destroy).toHaveBeenCalled();
	});

	it("requests A4 with 20mm margins and printBackground=true", async () => {
		const outputPath = join(workspace, "opts.pdf");
		await exportPdfImpl(SENDER_ID, "<html></html>", outputPath);
		const printToPDF = createdWindows[0].webContents.printToPDF;
		expect(printToPDF).toHaveBeenCalledTimes(1);
		const opts = (printToPDF.mock.calls[0] as unknown[])[0] as {
			pageSize: string;
			margins: { top: number };
			printBackground: boolean;
		};
		expect(opts.pageSize).toBe("A4");
		expect(opts.margins.top).toBeCloseTo(0.787, 3);
		expect(opts.printBackground).toBe(true);
	});

	it("registers a 300s overall export timeout", async () => {
		// 各ステージ（loadFile / fonts.ready / printToPDF）の個別 timeout は持たず、
		// **export 全体** に 300s（旧 Tauri 版と同じ PDF_EXPORT_TIMEOUT_SECS=300）の
		// 単一予算をかけていることを spy で確認する。fake timer + advance では microtask
		// との同期が難しい（5s 内に進めきれず vitest test timeout に引っかかる）ため、
		// 「300_000ms の setTimeout が 1 度発生していること」を回帰として固定する。
		const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
		try {
			const outputPath = join(workspace, "spy.pdf");
			await exportPdfImpl(SENDER_ID, "<html></html>", outputPath);
			const had300s = setTimeoutSpy.mock.calls.some((args) => args[1] === 300_000);
			expect(had300s).toBe(true);
		} finally {
			setTimeoutSpy.mockRestore();
		}
	});
});

describe("shouldAllowPdfRequest (PDF subresource SSRF filter)", () => {
	it("allows about:blank", () => {
		expect(shouldAllowPdfRequest("about:blank")).toBe(true);
	});
	it("allows data: URIs", () => {
		expect(shouldAllowPdfRequest("data:image/png;base64,iVBORw0K")).toBe(true);
	});
	it("allows https: to public hostname", () => {
		expect(shouldAllowPdfRequest("https://example.com/image.png")).toBe(true);
	});
	it("blocks http: to public hostname (force https)", () => {
		expect(shouldAllowPdfRequest("http://example.com/image.png")).toBe(false);
	});
	it("blocks https: to private IP literal (RFC 1918)", () => {
		expect(shouldAllowPdfRequest("https://10.0.0.1/")).toBe(false);
		expect(shouldAllowPdfRequest("https://192.168.1.1/")).toBe(false);
	});
	it("blocks https: to loopback IPv4", () => {
		expect(shouldAllowPdfRequest("https://127.0.0.1/")).toBe(false);
	});
	it("blocks https: to cloud metadata service (169.254.169.254)", () => {
		expect(shouldAllowPdfRequest("https://169.254.169.254/latest/meta-data/")).toBe(false);
	});
	it("blocks https: to IPv6 loopback", () => {
		expect(shouldAllowPdfRequest("https://[::1]/")).toBe(false);
	});
	it("allows https: to global IP literal", () => {
		expect(shouldAllowPdfRequest("https://1.1.1.1/")).toBe(true);
	});
	it("blocks chrome:// and other special schemes", () => {
		expect(shouldAllowPdfRequest("chrome://settings")).toBe(false);
		expect(shouldAllowPdfRequest("chrome-extension://abcd/")).toBe(false);
	});
	it("rejects unparseable URLs", () => {
		expect(shouldAllowPdfRequest("not-a-url")).toBe(false);
	});
	it("file: only allowed under OS tmpdir", () => {
		const tmp = tmpdir();
		// Node の loadFile が出す file:// URL は POSIX/Windows 両方で
		// `new URL(...).pathname` が `/<drive>:/...` または `/var/...` の表記になる。
		// shouldAllowPdfRequest は内部で `fileURLToPath` で OS ネイティブ表現へ
		// 戻してから tmpdir prefix と比較するので、現在 OS のフォーマットの URL を
		// pathToFileURL 経由で組んで test する。
		const tmpUrlInside = pathToFileURL(join(tmp, "scripta-pdf-x", "export.html")).toString();
		expect(shouldAllowPdfRequest(tmpUrlInside)).toBe(true);
		expect(shouldAllowPdfRequest("file:///etc/passwd")).toBe(false);
	});
});
