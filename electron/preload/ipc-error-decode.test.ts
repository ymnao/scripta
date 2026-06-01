import { describe, expect, it } from "vitest";
import { StructuredError, serializeIpcError } from "../main/utils/structured-error";
import { type DecodedIpcError, rebuildIpcError } from "./ipc-error-decode";

// main の serializeIpcError が作る encoded Error を、preload の rebuildIpcError が
// kind 付き Error へ復元できることを end-to-end で確認する（IPC 越えの再現）。

describe("rebuildIpcError", () => {
	it("restores kind / path from a serialized StructuredError", () => {
		const serialized = serializeIpcError(
			new StructuredError("ALREADY_EXISTS", "Already exists: /x", { path: "/x" }),
		);
		const rebuilt = rebuildIpcError(serialized) as DecodedIpcError;
		expect(rebuilt).toBeInstanceOf(Error);
		expect(rebuilt.kind).toBe("ALREADY_EXISTS");
		expect(rebuilt.path).toBe("/x");
		expect(rebuilt.message).toBe("Already exists: /x");
	});

	it("restores kind / code from a serialized errno error", () => {
		const errno = Object.assign(new Error("ENOENT: no such file"), { code: "ENOENT" });
		const rebuilt = rebuildIpcError(serializeIpcError(errno)) as DecodedIpcError;
		expect(rebuilt.kind).toBe("ENOENT");
		expect(rebuilt.code).toBe("ENOENT");
	});

	it("decodes even when Electron prefixes the invoke error message", () => {
		const encoded = serializeIpcError(new StructuredError("NETWORK", "offline"));
		const wrapped = new Error(`Error invoking remote method 'git:pull': Error: ${encoded.message}`);
		const rebuilt = rebuildIpcError(wrapped) as DecodedIpcError;
		expect(rebuilt.kind).toBe("NETWORK");
	});

	it("passes through non-structured errors unchanged", () => {
		const plain = new Error("plain failure");
		expect(rebuildIpcError(plain)).toBe(plain);
	});
});
