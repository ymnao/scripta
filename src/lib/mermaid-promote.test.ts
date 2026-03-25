import DOMPurify from "dompurify";
import { describe, expect, it } from "vitest";
import { promoteMermaidStyles, sanitizeMermaidSvg } from "./mermaid";

/**
 * htmlLabels: false で Mermaid が生成する SVG に近い構造。
 * foreignObject なし、<style> に ID セレクタ付き CSS ルール、
 * <text>/<tspan> でテキストを表示する形式。
 */
const FLOWCHART_SVG = `<svg id="mermaid-0" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 300 200" width="100%" style="max-width: 300px;">
<style>#mermaid-0{font-family:"trebuchet ms",verdana,arial,sans-serif;font-size:14px;fill:#333;}#mermaid-0 .label{font-family:"trebuchet ms",verdana,arial,sans-serif;}#mermaid-0 .label text,#mermaid-0 .label span{fill:#333;color:#333;}#mermaid-0 .node rect,#mermaid-0 .node circle,#mermaid-0 .node ellipse,#mermaid-0 .node polygon,#mermaid-0 .node path{fill:#ECECFF;stroke:#9370DB;stroke-width:1px;}#mermaid-0 .edgePath .path{stroke:#333;stroke-width:2.0px;}#mermaid-0 .flowchart-link{stroke:#333;fill:none;}#mermaid-0 .cluster rect{fill:#ffffde;stroke:#aaaa33;stroke-width:1px;}#mermaid-0 .cluster text{fill:#333;}</style>
<g>
  <g class="node" id="flowchart-A-0">
    <rect x="0" y="0" width="100" height="40" rx="5" ry="5" class="basic label-container" />
    <g class="label" transform="translate(10, 10)">
      <g>
        <rect class="background" style="stroke: none" />
        <text y="-10.1">
          <tspan class="text-outer-tspan" x="0" y="-0.1em" dy="1.1em">
            <tspan class="text-inner-tspan" font-style="normal" font-weight="normal">Hello</tspan>
          </tspan>
        </text>
      </g>
    </g>
  </g>
  <g class="edgePaths">
    <path class="flowchart-link" d="M50,40L50,80" />
  </g>
  <g class="node" id="flowchart-B-1">
    <rect x="0" y="80" width="100" height="40" rx="5" ry="5" class="basic label-container" />
    <g class="label" transform="translate(10, 90)">
      <g>
        <rect class="background" style="stroke: none" />
        <text y="-10.1">
          <tspan class="text-outer-tspan" x="0" y="-0.1em" dy="1.1em">
            <tspan class="text-inner-tspan" font-style="normal" font-weight="normal">World</tspan>
          </tspan>
        </text>
      </g>
    </g>
  </g>
</g>
</svg>`;

describe("promoteMermaidStyles", () => {
	it("sanitizeMermaidSvg が foreignObject なしの SVG で <style> 内容を保持する", () => {
		const result = sanitizeMermaidSvg(FLOWCHART_SVG);
		expect(result).toContain("<style>");
		expect(result).toContain("#mermaid-0");
		expect(result).toContain("font-family");
		expect(result).toContain("fill:#ECECFF");
		expect(result).toContain("stroke:#9370DB");
	});

	it("DOMParser(XML) vs innerHTML(HTML) での querySelectorAll の違い", () => {
		const result = sanitizeMermaidSvg(FLOWCHART_SVG);

		expect(result).toContain('id="mermaid-0"');
		expect(result).toContain('class="node"');

		// DOMParser (image/svg+xml)
		const parser = new DOMParser();
		const doc = parser.parseFromString(result, "image/svg+xml");
		const svgFromXml = doc.documentElement;

		expect(svgFromXml.getAttribute("id")).toBe("mermaid-0");
		expect(svgFromXml.querySelector(".node rect")).not.toBeNull();

		const xmlIdResult = svgFromXml.querySelectorAll("#mermaid-0 .node rect").length;
		const xmlClassResult = svgFromXml.querySelectorAll(".node rect").length;

		// innerHTML (HTML コンテキスト) — 実際の toDOM フロー
		const inner = document.createElement("div");
		inner.innerHTML = result;
		const svgFromHtml = inner.querySelector("svg");

		expect(svgFromHtml).not.toBeNull();
		expect(svgFromHtml?.getAttribute("id")).toBe("mermaid-0");

		const htmlIdResult = svgFromHtml?.querySelectorAll("#mermaid-0 .node rect").length ?? 0;
		const htmlClassResult = svgFromHtml?.querySelectorAll(".node rect").length ?? 0;

		// XML コンテキストでは ID セレクタが機能しない（jsdom の制約）
		expect(xmlIdResult).toBe(0);
		expect(xmlClassResult).toBe(4);
		// HTML コンテキスト（実際の toDOM フロー）では ID セレクタも機能する
		expect(htmlIdResult).toBe(4);
		expect(htmlClassResult).toBe(4);
	});

	it("promoteMermaidStyles が HTML コンテキストでプレゼンテーション属性を設定する", () => {
		const sanitized = sanitizeMermaidSvg(FLOWCHART_SVG);

		const inner = document.createElement("div");
		inner.innerHTML = sanitized;
		const svgEl = inner.querySelector("svg");
		expect(svgEl).not.toBeNull();
		if (!svgEl) return;

		const styleEl = svgEl.querySelector("style");
		expect(styleEl).not.toBeNull();
		expect(styleEl?.textContent).toContain("font-family");

		promoteMermaidStyles(svgEl);

		// .node rect にプレゼンテーション属性 fill, stroke が設定される
		const nodeRect = svgEl.querySelector(".node rect");
		expect(nodeRect).not.toBeNull();
		// CSSStyleSheet は色値を rgb() 形式に正規化する
		expect(nodeRect?.getAttribute("fill")).toBeTruthy();
		expect(nodeRect?.getAttribute("stroke")).toBeTruthy();
		expect(nodeRect?.getAttribute("stroke-width")).toBe("1px");

		// .label text にフォントのプレゼンテーション属性が設定される
		const textEl = svgEl.querySelector(".label text");
		expect(textEl).not.toBeNull();
		expect(textEl?.getAttribute("font-family")).toBeTruthy();

		// SVG ルートに fill が設定される（CSSStyleSheet が色を rgb() に正規化）
		expect(svgEl.getAttribute("fill")).toBeTruthy();
		expect(svgEl.getAttribute("font-family")).toBeTruthy();

		// .flowchart-link に stroke が設定される
		const link = svgEl.querySelector(".flowchart-link");
		expect(link).not.toBeNull();
		expect(link?.getAttribute("stroke")).toBeTruthy();
	});

	it("CSSStyleSheet.replaceSync で Mermaid CSS を正しくパースできる", () => {
		const sanitized = sanitizeMermaidSvg(FLOWCHART_SVG);
		const inner = document.createElement("div");
		inner.innerHTML = sanitized;
		const svgEl = inner.querySelector("svg");
		expect(svgEl).not.toBeNull();
		if (!svgEl) return;

		const styleEl = svgEl.querySelector("style");
		expect(styleEl).not.toBeNull();

		const sheet = new CSSStyleSheet();
		sheet.replaceSync(styleEl?.textContent ?? "");

		expect(sheet.cssRules.length).toBeGreaterThan(0);

		const selectors = Array.from(sheet.cssRules)
			.filter((r): r is CSSStyleRule => r instanceof CSSStyleRule)
			.map((r) => r.selectorText);
		expect(selectors.some((s) => s.includes("#mermaid-0"))).toBe(true);
	});

	it("querySelectorAll が HTML コンテキストで ID セレクタ付きルールの要素を見つける", () => {
		const sanitized = sanitizeMermaidSvg(FLOWCHART_SVG);

		const inner = document.createElement("div");
		inner.innerHTML = sanitized;
		const svgEl = inner.querySelector("svg");
		expect(svgEl).not.toBeNull();
		if (!svgEl) return;

		const styleEl = svgEl.querySelector("style");
		const sheet = new CSSStyleSheet();
		sheet.replaceSync(styleEl?.textContent ?? "");

		const matchResults: Record<string, number> = {};
		for (const rule of sheet.cssRules) {
			if (!(rule instanceof CSSStyleRule)) continue;
			try {
				const targets = svgEl.querySelectorAll(rule.selectorText);
				if (targets.length > 0) {
					matchResults[rule.selectorText] = targets.length;
				}
			} catch {
				// 擬似クラス等はスキップ
			}
		}

		expect(Object.keys(matchResults).length).toBeGreaterThan(0);
	});
});

describe("DOMPurify と text-anchor 属性", () => {
	it("DOMPurify が text-anchor 属性とインラインスタイルを保持する", () => {
		const svg = `<svg xmlns="http://www.w3.org/2000/svg" id="mermaid-0">
<text text-anchor="middle" x="100" y="50">Hello</text>
<text style="text-anchor: middle; font-size: 14px" x="300" y="50">Styled</text>
</svg>`;

		// mermaid 内部 DOMPurify
		const mermaidResult = DOMPurify.sanitize(svg, {
			ADD_TAGS: ["foreignobject"],
			ADD_ATTR: ["dominant-baseline"],
			HTML_INTEGRATION_POINTS: { foreignobject: true },
		});
		expect(mermaidResult).toContain('text-anchor="middle"');
		expect(mermaidResult).toContain("text-anchor: middle");

		// sanitizeMermaidSvg
		const ourResult = sanitizeMermaidSvg(svg);
		expect(ourResult).toContain('text-anchor="middle"');
		expect(ourResult).toContain("text-anchor: middle");
	});
});
