import { describe, expect, it } from "vitest";
import { decodeIpcError } from "../../src/types/errors";
import { StructuredError, serializeIpcError } from "../main/utils/structured-error";
import { rebuildIpcError } from "./ipc-error-decode";

// main の serializeIpcError が作る encoded Error を、preload の rebuildIpcError が
// 「clean な sentinel payload を message に持つ Error」へ正規化できることを確認する。
//
// contextBridge は Error のカスタムプロパティ（kind/code/path）を剥がすため、kind 等は
// message（sentinel payload）に載せて renderer へ運ぶ。renderer 側は decodeIpcError で
// 復元する。本テストはその「message に payload が載っている」ことを decode して検証する。

describe("rebuildIpcError", () => {
	it("carries kind / path in the message payload (re-encoded sentinel)", () => {
		const serialized = serializeIpcError(
			new StructuredError("ALREADY_EXISTS", "Already exists: /x", { path: "/x" }),
		);
		const rebuilt = rebuildIpcError(serialized);
		expect(rebuilt).toBeInstanceOf(Error);
		const decoded = decodeIpcError((rebuilt as Error).message);
		expect(decoded).toEqual({ kind: "ALREADY_EXISTS", message: "Already exists: /x", path: "/x" });
	});

	it("carries kind / code from a serialized errno error", () => {
		const errno = Object.assign(new Error("ENOENT: no such file"), { code: "ENOENT" });
		const rebuilt = rebuildIpcError(serializeIpcError(errno));
		const decoded = decodeIpcError((rebuilt as Error).message);
		expect(decoded?.kind).toBe("ENOENT");
		expect(decoded?.code).toBe("ENOENT");
		expect(decoded?.message).toBe("ENOENT: no such file");
	});

	it("normalizes away the Electron invoke prefix into a clean sentinel", () => {
		const encoded = serializeIpcError(new StructuredError("NETWORK", "offline"));
		const wrapped = new Error(`Error invoking remote method 'git:pull': Error: ${encoded.message}`);
		const rebuilt = rebuildIpcError(wrapped);
		// 正規化後の message は prefix の無い 1 行 sentinel になっている。
		expect((rebuilt as Error).message.startsWith("SCRIPTA_STRUCTURED_ERR:")).toBe(true);
		expect(decodeIpcError((rebuilt as Error).message)?.kind).toBe("NETWORK");
	});

	it("recovers kind even when Electron appends a stack after the JSON", () => {
		const encoded = serializeIpcError(new StructuredError("GIT_NOTHING_TO_COMMIT", "nothing"));
		const withStack = new Error(`${encoded.message}\n    at handler (out/main/index.js:1:1)`);
		const rebuilt = rebuildIpcError(withStack);
		expect(decodeIpcError((rebuilt as Error).message)?.kind).toBe("GIT_NOTHING_TO_COMMIT");
	});

	it("passes through non-structured errors unchanged", () => {
		const plain = new Error("plain failure");
		expect(rebuildIpcError(plain)).toBe(plain);
	});
});
