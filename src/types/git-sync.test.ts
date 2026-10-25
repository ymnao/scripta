import { describe, expect, it } from "vitest";
import { isSameSyncHalt } from "./git-sync";

describe("isSameSyncHalt", () => {
	it("treats unsafe-config halts with the same detail as the same", () => {
		expect(
			isSameSyncHalt(
				{ reason: "unsafe-config", detail: "core.fsmonitor" },
				{ reason: "unsafe-config", detail: "core.fsmonitor" },
			),
		).toBe(true);
	});

	it("treats unsafe-config halts with a different detail as different", () => {
		expect(
			isSameSyncHalt(
				{ reason: "unsafe-config", detail: "core.fsmonitor" },
				{ reason: "unsafe-config", detail: "credential.helper" },
			),
		).toBe(false);
	});
});
