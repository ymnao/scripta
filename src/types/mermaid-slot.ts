/**
 * mermaid SVG を `finalizeHtml` の sanitize 後に差し戻すための受け渡し領域。
 * `preprocessMermaidBlocks` が SVG の代わりに空の slot div を出して `svgs` に積み、
 * `finalizeHtml` が sanitize 後に nonce の一致する slot へ差し戻す。
 */
export interface MermaidSlotStore {
	nonce: string;
	svgs: Map<string, string>;
}

export function createMermaidSlotStore(): MermaidSlotStore {
	return { nonce: crypto.randomUUID(), svgs: new Map() };
}
