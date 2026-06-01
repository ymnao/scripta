import { describe, expect, it } from "vitest";
import {
	decodeIpcError,
	encodeIpcError,
	getErrorKind,
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

	it("returns null when required fields are missing", () => {
		expect(decodeIpcError(`${IPC_ERROR_SENTINEL}{"message":"no kind"}`)).toBeNull();
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
});
