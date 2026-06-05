import { describe, expect, it } from "vitest";
import {
	decodeIpcError,
	encodeIpcError,
	getErrorKind,
	getStructuredMessage,
	IPC_ERROR_SENTINEL,
	type StructuredErrorData,
} from "./errors";

describe("encodeIpcError / decodeIpcError", () => {
	it("roundtrips a full payload", () => {
		const data: StructuredErrorData = {
			kind: "ENOENT",
			message: "ENOENT: no such file",
			code: "ENOENT",
			path: "/tmp/x",
		};
		expect(decodeIpcError(encodeIpcError(data))).toEqual(data);
	});

	it("roundtrips a minimal payload (kind + message only)", () => {
		const data: StructuredErrorData = { kind: "GIT_CONFLICT", message: "CONFLICT" };
		expect(decodeIpcError(encodeIpcError(data))).toEqual(data);
	});

	it("decodes even when the sentinel is prefixed (Electron invoke wrapping)", () => {
		const encoded = encodeIpcError({ kind: "EACCES", message: "denied" });
		const wrapped = `Error invoking remote method 'fs:read': Error: ${encoded}`;
		expect(decodeIpcError(wrapped)).toEqual({ kind: "EACCES", message: "denied" });
	});

	it("returns null for messages without the sentinel", () => {
		expect(decodeIpcError("plain error message")).toBeNull();
	});

	it("returns null for a corrupt JSON payload", () => {
		expect(decodeIpcError(`${IPC_ERROR_SENTINEL}{not json`)).toBeNull();
	});

	it("decodes when an error stack is appended after the JSON (Electron 42 reject)", () => {
		// Electron 42 以降、invoke reject の message に error stack が連結されると
		// sentinel 以降を末尾まで JSON.parse できず kind が落ちていた（git の
		// "nothing to commit" が「予期しないエラー」に化ける原因）。fallback の
		// brace 走査で JSON 本体だけを取り出して復元する。
		const encoded = encodeIpcError({
			kind: "GIT_NOTHING_TO_COMMIT",
			message: "On branch main\nnothing to commit, working tree clean",
		});
		const withStack = `${encoded}\n    at commitImpl (out/main/index.js:198:9)\n    at async Session.<anonymous>`;
		expect(decodeIpcError(withStack)).toEqual({
			kind: "GIT_NOTHING_TO_COMMIT",
			message: "On branch main\nnothing to commit, working tree clean",
		});
	});

	it("decodes with both Electron prefix wrap and a trailing stack", () => {
		const encoded = encodeIpcError({ kind: "EACCES", message: "denied" });
		const wrapped = `Error invoking remote method 'fs:read': Error: ${encoded}\n    at handler`;
		expect(decodeIpcError(wrapped)).toEqual({ kind: "EACCES", message: "denied" });
	});

	it("extracts the JSON object even when the message value contains braces", () => {
		// message に `{` / `}` が含まれていても brace 走査は文字列リテラル内を
		// スキップするため誤って途中で閉じない。
		const encoded = encodeIpcError({
			kind: "INVALID_PATH",
			message: 'bad path: {nested} and "quoted" stuff',
		});
		const withStack = `${encoded}\n    at somewhere`;
		expect(decodeIpcError(withStack)).toEqual({
			kind: "INVALID_PATH",
			message: 'bad path: {nested} and "quoted" stuff',
		});
	});

	it("still returns null when the appended trailing content is the only brace", () => {
		// JSON 本体が無く trailing しか無い（= 完結オブジェクト無し）なら null。
		expect(decodeIpcError(`${IPC_ERROR_SENTINEL}not json at all { unclosed`)).toBeNull();
	});

	it("rejects garbage between the sentinel and the JSON object (fallback trust boundary)", () => {
		// fallback は「valid な sentinel + JSON の末尾に Electron の stack が連結した
		// ケース」だけを救う。sentinel 直後に任意の garbage を許すと、未ラップの IPC や
		// user-controlled な raw message が混入したときに UI 表示や retry 判定を誤分類
		// する余地ができる。先頭は JSON.parse と整合的に whitespace のみ許容する。
		const validPayload = JSON.stringify({ kind: "NETWORK", message: "x" });
		expect(decodeIpcError(`${IPC_ERROR_SENTINEL}not json ${validPayload}`)).toBeNull();
		expect(decodeIpcError(`${IPC_ERROR_SENTINEL}garbage${validPayload}`)).toBeNull();
	});

	it("tolerates only leading whitespace between the sentinel and the JSON object", () => {
		// JSON.parse と同じく先頭 whitespace は許容する。
		const validPayload = JSON.stringify({ kind: "NETWORK", message: "x" });
		expect(decodeIpcError(`${IPC_ERROR_SENTINEL}  \t\n${validPayload}`)).toEqual({
			kind: "NETWORK",
			message: "x",
		});
	});

	it("returns null when required fields are missing", () => {
		expect(decodeIpcError(`${IPC_ERROR_SENTINEL}{"message":"no kind"}`)).toBeNull();
	});

	it("drops optional fields (code / path) that are not strings", () => {
		const wire = `${IPC_ERROR_SENTINEL}${JSON.stringify({
			kind: "ENOENT",
			message: "m",
			code: 123,
			path: ["not", "a", "string"],
		})}`;
		expect(decodeIpcError(wire)).toEqual({ kind: "ENOENT", message: "m" });
	});

	it("does not reconstruct from prototype-injected fields (__proto__ payload)", () => {
		// own property としての kind/message を持たないため復元しない。
		const wire = `${IPC_ERROR_SENTINEL}{"__proto__":{"kind":"ENOENT","message":"x"}}`;
		expect(decodeIpcError(wire)).toBeNull();
	});
});

describe("getErrorKind", () => {
	it("reads kind from an object", () => {
		expect(getErrorKind({ kind: "TIMEOUT" })).toBe("TIMEOUT");
	});

	it("reads kind from an Error with kind attached", () => {
		expect(getErrorKind(Object.assign(new Error("x"), { kind: "NETWORK" }))).toBe("NETWORK");
	});

	it("returns undefined for kind-less values", () => {
		expect(getErrorKind(new Error("x"))).toBeUndefined();
		expect(getErrorKind("string")).toBeUndefined();
		expect(getErrorKind(null)).toBeUndefined();
		expect(getErrorKind(42)).toBeUndefined();
	});

	it("ignores kind inherited from the prototype chain (own property only)", () => {
		const inherited = Object.create({ kind: "ENOENT" });
		expect(getErrorKind(inherited)).toBeUndefined();
	});

	it("recovers kind from a sentinel-encoded message when no own kind (bridge stripped it)", () => {
		// contextBridge は Error の kind プロパティを剥がすため、実 IPC 経路では
		// message に載った sentinel payload からしか kind を取れない。
		const encoded = encodeIpcError({ kind: "GIT_NOTHING_TO_COMMIT", message: "nothing" });
		const bridged = new Error(encoded); // kind プロパティ無し（剥がされた状態を再現）
		expect(getErrorKind(bridged)).toBe("GIT_NOTHING_TO_COMMIT");
	});

	it("prefers an own kind property over the message payload", () => {
		const encoded = encodeIpcError({ kind: "NETWORK", message: "x" });
		const err = Object.assign(new Error(encoded), { kind: "TIMEOUT" });
		expect(getErrorKind(err)).toBe("TIMEOUT");
	});

	it("returns undefined for a plain (non-sentinel) message", () => {
		expect(getErrorKind(new Error("just a normal failure"))).toBeUndefined();
	});
});

describe("getStructuredMessage", () => {
	it("extracts the human message from a sentinel-encoded message", () => {
		const encoded = encodeIpcError({
			kind: "GIT_NOTHING_TO_COMMIT",
			message: "On branch main\nnothing to commit, working tree clean",
		});
		expect(getStructuredMessage(new Error(encoded))).toBe(
			"On branch main\nnothing to commit, working tree clean",
		);
	});

	it("returns the raw message for a non-sentinel error", () => {
		expect(getStructuredMessage(new Error("plain failure"))).toBe("plain failure");
	});

	it("handles string and non-error inputs", () => {
		expect(getStructuredMessage("a string")).toBe("a string");
		expect(getStructuredMessage(42)).toBe("42");
	});
});
