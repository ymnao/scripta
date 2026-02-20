import { getMockStore } from "./types";

export async function open(url: string): Promise<void> {
	const store = getMockStore();
	if (!store.calls["shell:open"]) {
		store.calls["shell:open"] = [];
	}
	store.calls["shell:open"].push({ url });
}
