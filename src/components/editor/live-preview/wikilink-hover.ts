import type { Extension } from "@codemirror/state";
import { type PluginValue, ViewPlugin } from "@codemirror/view";
import { basename } from "../../../lib/path";
import { useWikilinkStore } from "../../../stores/wikilink";
import type { UnresolvedWikilink } from "../../../types/wikilink";

class WikilinkHoverPlugin implements PluginValue {
	private popup: HTMLDivElement | null = null;
	private hoverTimeout: ReturnType<typeof setTimeout> | null = null;
	private closeTimeout: ReturnType<typeof setTimeout> | null = null;
	private unsubscribeStore: (() => void) | null = null;
	private dom: HTMLElement;

	constructor(view: { dom: HTMLElement }) {
		this.dom = view.dom;
		this.dom.addEventListener("mouseover", this.handleMouseOver);
		this.dom.addEventListener("mouseout", this.handleMouseOut);
	}

	private handleMouseOver = (e: Event) => {
		const me = e as MouseEvent;
		const target = me.target;
		if (!(target instanceof Element)) return;
		const wikilinkEl = target.closest<HTMLElement>(".cm-wikilink-missing");
		if (!wikilinkEl) return;

		// Cancel any pending close
		if (this.closeTimeout) {
			clearTimeout(this.closeTimeout);
			this.closeTimeout = null;
		}

		// Extract page name from the resolved path attribute
		const wikilinkPath = wikilinkEl.dataset.wikilinkPath;
		if (!wikilinkPath) return;
		const normalizedPage = basename(wikilinkPath).replace(/\.md$/i, "").normalize("NFC");
		if (!normalizedPage) return;

		// If already showing popup for this page, do nothing
		if (this.popup && this.popup.dataset.pageName === normalizedPage) return;

		if (this.hoverTimeout) clearTimeout(this.hoverTimeout);
		this.hoverTimeout = setTimeout(() => {
			this.showPopup(wikilinkEl, normalizedPage);
		}, 300);
	};

	private handleMouseOut = (e: Event) => {
		const me = e as MouseEvent;
		const relatedTarget = me.relatedTarget as Element | null;

		// Don't close if moving to popup
		if (this.popup?.contains(relatedTarget)) return;

		if (this.hoverTimeout) {
			clearTimeout(this.hoverTimeout);
			this.hoverTimeout = null;
		}

		// Delay close to allow mouse to move to popup
		this.scheduleClose();
	};

	private scheduleClose() {
		if (this.closeTimeout) clearTimeout(this.closeTimeout);
		this.closeTimeout = setTimeout(() => {
			// Don't close if textarea is focused
			const textarea = this.popup?.querySelector("textarea");
			if (textarea && document.activeElement === textarea) return;
			if (this.popup?.matches(":hover")) return;
			this.closePopup();
		}, 150);
	}

	private showPopup(anchor: HTMLElement, pageName: string) {
		this.closePopup();

		const rect = anchor.getBoundingClientRect();
		const popup = document.createElement("div");
		popup.dataset.pageName = pageName;

		// Styles
		popup.style.cssText = [
			"position: fixed",
			"z-index: 1000",
			"background: var(--color-bg-primary)",
			"border: 1px solid var(--color-border)",
			"border-radius: 6px",
			"box-shadow: 0 4px 12px rgba(0,0,0,0.15)",
			"padding: 10px",
			"width: 260px",
			"font-size: 12px",
			"color: var(--color-text-primary)",
		].join(";");

		// Position below anchor
		const top = rect.bottom + 4;
		const left = Math.max(4, Math.min(rect.left, window.innerWidth - 268));
		popup.style.left = `${left}px`;
		popup.style.top = `${top}px`;

		// Flip above if not enough space below
		if (top + 200 > window.innerHeight) {
			popup.style.top = `${rect.top - 4}px`;
			popup.style.transform = "translateY(-100%)";
		}

		this.buildContent(popup, pageName);

		// Popup mouse events
		popup.addEventListener("mouseenter", () => {
			if (this.closeTimeout) {
				clearTimeout(this.closeTimeout);
				this.closeTimeout = null;
			}
		});
		popup.addEventListener("mouseleave", () => {
			const textarea = popup.querySelector("textarea");
			if (textarea && document.activeElement === textarea) return;
			this.scheduleClose();
		});

		document.body.appendChild(popup);
		this.popup = popup;

		// スキャン完了で popup 内容を再描画（初回スキャン前に開いた場合に対応）
		this.unsubscribeStore = useWikilinkStore.subscribe((state, prevState) => {
			if (state.unresolvedLinks !== prevState.unresolvedLinks && this.popup) {
				// ドラフト入力中のテキストを保持
				const textarea = this.popup.querySelector("textarea");
				const currentDraft = textarea?.value ?? "";
				if (currentDraft) {
					useWikilinkStore.getState().setDraft(pageName, currentDraft);
				}
				while (this.popup.firstChild) this.popup.removeChild(this.popup.firstChild);
				this.buildContent(this.popup, pageName);
			}
		});
	}

	private buildContent(popup: HTMLDivElement, pageName: string) {
		const store = useWikilinkStore.getState();
		const draft = store.getDraft(pageName);
		const link = store.unresolvedLinks.find((l) => l.pageName === pageName);
		const refCount = link?.references.length ?? 0;

		// Header
		const header = document.createElement("div");
		header.style.cssText =
			"display: flex; align-items: center; justify-content: space-between; margin-bottom: 8px;";

		const nameSpan = document.createElement("span");
		nameSpan.style.cssText = "font-weight: 600; overflow: hidden; text-overflow: ellipsis;";
		nameSpan.textContent = pageName;
		header.appendChild(nameSpan);

		if (refCount > 0) {
			const countSpan = document.createElement("span");
			countSpan.style.cssText =
				"font-size: 11px; color: var(--color-text-secondary); white-space: nowrap; margin-left: 8px;";
			countSpan.textContent = `${refCount} 件の参照`;
			header.appendChild(countSpan);
		}

		popup.appendChild(header);

		// Textarea
		const textarea = document.createElement("textarea");
		textarea.placeholder = "ドラフトを入力...";
		textarea.value = draft;
		textarea.rows = 3;
		textarea.style.cssText = [
			"width: 100%",
			"box-sizing: border-box",
			"resize: vertical",
			"border: 1px solid var(--color-border)",
			"border-radius: 4px",
			"background: var(--color-bg-secondary)",
			"color: var(--color-text-primary)",
			"padding: 6px 8px",
			"font-size: 12px",
			"font-family: inherit",
			"margin-bottom: 8px",
			"outline: none",
		].join(";");
		textarea.addEventListener("input", () => {
			useWikilinkStore.getState().setDraft(pageName, textarea.value);
		});
		textarea.addEventListener("focus", () => {
			if (this.closeTimeout) {
				clearTimeout(this.closeTimeout);
				this.closeTimeout = null;
			}
		});
		textarea.addEventListener("blur", () => {
			this.scheduleClose();
		});
		popup.appendChild(textarea);

		// Create button
		const button = document.createElement("button");
		button.type = "button";
		button.textContent = "ファイルを作成";
		button.style.cssText = [
			"width: 100%",
			"padding: 4px 8px",
			"border: 1px solid var(--color-border)",
			"border-radius: 4px",
			"background: var(--color-bg-secondary)",
			"color: var(--color-text-primary)",
			"font-size: 12px",
			"cursor: pointer",
		].join(";");
		button.addEventListener("mouseenter", () => {
			button.style.background = "var(--color-bg-primary)";
		});
		button.addEventListener("mouseleave", () => {
			button.style.background = "var(--color-bg-secondary)";
		});
		button.addEventListener("click", () => {
			// クリック時に最新の参照を取得（スキャンが popup 表示後に完了している可能性）
			const latestLink = useWikilinkStore
				.getState()
				.unresolvedLinks.find((l) => l.pageName === pageName);
			useWikilinkStore
				.getState()
				.setCreateTarget(pageName, latestLink?.references ?? link?.references ?? []);
			this.closePopup();
		});
		popup.appendChild(button);
	}

	private closePopup() {
		if (this.unsubscribeStore) {
			this.unsubscribeStore();
			this.unsubscribeStore = null;
		}
		if (this.popup) {
			this.popup.remove();
			this.popup = null;
		}
	}

	destroy() {
		this.dom.removeEventListener("mouseover", this.handleMouseOver);
		this.dom.removeEventListener("mouseout", this.handleMouseOut);
		this.closePopup();
		if (this.hoverTimeout) clearTimeout(this.hoverTimeout);
		if (this.closeTimeout) clearTimeout(this.closeTimeout);
	}
}

export const wikilinkHoverTooltip: Extension = ViewPlugin.fromClass(WikilinkHoverPlugin);
