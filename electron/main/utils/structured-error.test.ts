import { describe, expect, it } from "vitest";
import { decodeIpcError } from "../../../src/types/errors";
import {
	classifyErrno,
	classifyGitError,
	gitError,
	StructuredError,
	serializeIpcError,
	toStructuredData,
} from "./structured-error";

describe("classifyErrno", () => {
	it("maps known errno codes", () => {
		expect(classifyErrno("ENOENT")).toBe("ENOENT");
		expect(classifyErrno("EPERM")).toBe("EACCES");
		expect(classifyErrno("ENFILE")).toBe("EMFILE");
		expect(classifyErrno("EISDIR")).toBe("EISDIR");
		expect(classifyErrno("ENOTDIR")).toBe("ENOTDIR");
	});

	it("maps unknown / undefined codes to UNKNOWN", () => {
		expect(classifyErrno("EWHATEVER")).toBe("UNKNOWN");
		expect(classifyErrno(undefined)).toBe("UNKNOWN");
	});
});

describe("classifyGitError", () => {
	it("classifies network causes before the 'unable to access' wrapper", () => {
		expect(
			classifyGitError("fatal: unable to access 'https://...': Could not resolve host: github.com"),
		).toBe("NETWORK");
		expect(classifyGitError("Failed to connect to github.com port 443")).toBe("NETWORK");
		expect(classifyGitError("fatal: network is unreachable")).toBe("NETWORK");
	});

	it("classifies connection refused / timeout", () => {
		expect(classifyGitError("fatal: Connection refused")).toBe("CONNECTION_REFUSED");
		expect(classifyGitError("Connection timed out")).toBe("TIMEOUT");
	});

	it("classifies auth / conflict / nothing-to-commit", () => {
		expect(classifyGitError("fatal: Authentication failed for 'https://...'")).toBe("GIT_AUTH");
		expect(classifyGitError("CONFLICT (content): Merge conflict in file.md")).toBe("GIT_CONFLICT");
		expect(classifyGitError("nothing to commit, working tree clean")).toBe("GIT_NOTHING_TO_COMMIT");
	});

	it("classifies 'unable to access' without a network cause as GIT_NO_REMOTE_ACCESS", () => {
		expect(
			classifyGitError(
				"fatal: unable to access 'https://github.com/repo.git/': The requested URL returned error: 403",
			),
		).toBe("GIT_NO_REMOTE_ACCESS");
	});

	it("falls back to UNKNOWN", () => {
		expect(classifyGitError("some unrecognized git failure")).toBe("UNKNOWN");
	});
});

describe("toStructuredData", () => {
	it("passes through a StructuredError", () => {
		const e = new StructuredError("ALREADY_EXISTS", "Already exists: /x", { path: "/x" });
		expect(toStructuredData(e)).toEqual({
			kind: "ALREADY_EXISTS",
			message: "Already exists: /x",
			code: undefined,
			path: "/x",
		});
	});

	it("classifies a raw errno error", () => {
		const e = Object.assign(new Error("ENOENT: no such file"), { code: "ENOENT" });
		expect(toStructuredData(e)).toEqual({
			kind: "ENOENT",
			message: "ENOENT: no such file",
			code: "ENOENT",
		});
	});

	it("falls back to UNKNOWN for plain errors", () => {
		expect(toStructuredData(new Error("boom"))).toEqual({ kind: "UNKNOWN", message: "boom" });
	});
});

describe("gitError", () => {
	it("produces a StructuredError with classified kind and raw stderr message", () => {
		const e = gitError("CONFLICT (content): Merge conflict in a.md");
		expect(e).toBeInstanceOf(StructuredError);
		expect(e.kind).toBe("GIT_CONFLICT");
		expect(e.message).toBe("CONFLICT (content): Merge conflict in a.md");
	});
});

describe("serializeIpcError → decodeIpcError (wire roundtrip)", () => {
	it("roundtrips a StructuredError across the encoded message", () => {
		const original = new StructuredError("PATH_OUTSIDE_WORKSPACE", "Permission denied: outside", {
			path: "/etc/passwd",
		});
		const serialized = serializeIpcError(original);
		expect(decodeIpcError(serialized.message)).toEqual({
			kind: "PATH_OUTSIDE_WORKSPACE",
			message: "Permission denied: outside",
			code: undefined,
			path: "/etc/passwd",
		});
	});

	it("roundtrips an errno error", () => {
		const errno = Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
		expect(decodeIpcError(serializeIpcError(errno).message)).toEqual({
			kind: "EACCES",
			message: "EACCES: permission denied",
			code: "EACCES",
		});
	});
});
