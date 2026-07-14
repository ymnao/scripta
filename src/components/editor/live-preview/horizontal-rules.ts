import { WidgetType } from "@codemirror/view";
import { createHrReplaceDecoration } from "./plugin-utils";

export class HRWidget extends WidgetType {
	eq(_other: WidgetType): boolean {
		return true;
	}

	toDOM(): HTMLElement {
		const hr = document.createElement("hr");
		hr.className = "cm-hr-widget";
		return hr;
	}

	ignoreEvent(): boolean {
		return true;
	}
}

// カーソルがフォーカスされた行に HR がある場合は raw `---` のままにする挙動は
// createHrReplaceDecoration が担う。widget で replace するとカーソル進入時に
// 表示が崩れる（左端の白い点滅）ため、フォーカス外し時のみ replace する。
const hrDecoration = createHrReplaceDecoration(() => new HRWidget());

export const { buildDecorations } = hrDecoration;
export const horizontalRuleDecoration = hrDecoration.extension;
