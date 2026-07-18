import { describe, expect, it } from "vitest";
import { LruCache } from "./lru-cache";

describe("LruCache", () => {
	it("get / set / has / size / delete / clear の基本動作", () => {
		const c = new LruCache<string, number>(3);
		expect(c.size).toBe(0);
		c.set("a", 1);
		c.set("b", 2);
		expect(c.has("a")).toBe(true);
		expect(c.get("a")).toBe(1);
		expect(c.size).toBe(2);
		expect(c.delete("a")).toBe(true);
		expect(c.has("a")).toBe(false);
		c.clear();
		expect(c.size).toBe(0);
	});

	it("cap を超えると挿入順で最古を 1 件 evict する", () => {
		const c = new LruCache<string, number>(2);
		c.set("a", 1);
		c.set("b", 2);
		c.set("c", 3);
		expect(c.has("a")).toBe(false);
		expect(c.has("b")).toBe(true);
		expect(c.has("c")).toBe(true);
	});

	it("get は該当エントリを LRU 末尾へ移動する", () => {
		const c = new LruCache<string, number>(2);
		c.set("a", 1);
		c.set("b", 2);
		expect(c.get("a")).toBe(1);
		c.set("c", 3);
		expect(c.has("a")).toBe(true);
		expect(c.has("b")).toBe(false);
	});

	it("peek は LRU 順序を変えない", () => {
		const c = new LruCache<string, number>(2);
		c.set("a", 1);
		c.set("b", 2);
		expect(c.peek("a")).toBe(1);
		c.set("c", 3);
		expect(c.has("a")).toBe(false);
		expect(c.has("b")).toBe(true);
	});

	it("同一 key を set し直すと LRU 末尾へ移動する", () => {
		const c = new LruCache<string, number>(2);
		c.set("a", 1);
		c.set("b", 2);
		c.set("a", 10);
		c.set("c", 3);
		expect(c.has("a")).toBe(true);
		expect(c.has("b")).toBe(false);
		expect(c.get("a")).toBe(10);
	});

	it("protectFromEviction: 非 protect を優先し、足りなければ protect も evict する", () => {
		type Entry = { status: "keep" | "drop" };
		const c = new LruCache<string, Entry>(2, {
			protectFromEviction: (v) => v.status === "keep",
		});
		c.set("a", { status: "keep" });
		c.set("b", { status: "drop" });
		c.set("c", { status: "keep" });
		// size=3, cap=2 → drop 対象は b (非 protect) が先
		expect(c.has("a")).toBe(true);
		expect(c.has("b")).toBe(false);
		expect(c.has("c")).toBe(true);

		// 全 protect でも cap を超えたら挿入順で evict
		c.set("d", { status: "keep" });
		expect(c.has("a")).toBe(false);
		expect(c.has("c")).toBe(true);
		expect(c.has("d")).toBe(true);
	});

	it("values は挿入順 (LRU 更新後の順序) で列挙される", () => {
		const c = new LruCache<string, number>(3);
		c.set("a", 1);
		c.set("b", 2);
		c.set("c", 3);
		c.get("a"); // a を末尾へ
		expect([...c.values()]).toEqual([2, 3, 1]);
	});
});
