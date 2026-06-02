/**
 * PDF エクスポート用の動的改ページ判定スクリプトを構築する (#93)。
 *
 * 設計判断（grill-me セッション 14 で確定）:
 * - 旧 inline `<script>` 注入をやめ、main 側で組み立てた string を
 *   `webContents.executeJavaScript` で渡す（DOM/font ready 確定後に走らせる）。
 * - `safetyBuffer = 0`（Chromium 単一 WebView では誤差が小さいため、buffer を
 *   持たせるより「収まらないなら次ページ送り」を Chromium の `break-before: auto`
 *   フォールバックに任せる方が widow 発生を抑えられる）。
 * - `forceUpperBreak` は内部仕様で常に ON（UI 非露出）— 「章は常に改ページ、
 *   節は smart 抑制」が自然な期待値。
 * - 旧 `firstTargetHeading` 抑制は削除（CSS 仕様で「最初の要素の forced break
 *   は無視」が規定されているため不要）。
 * - `<hr class="pdf-pagebreak">` を著者マーカーとして検出し pageUsed を 0 に戻す。
 * - criterion = "compact" → 見出し + 直後の最初の本文ブロック が現ページ残量に収まれば抑制。
 * - criterion = "section" → 見出し + 次の同位以上の見出しまでが収まれば抑制。
 *
 * 戻り値の string は IIFE で `try/finally` 相当のクリーンアップを含む。
 */

import type { PdfPageBreakOptions } from "../../../src/types/pdf";

// renderer 側と同一の型を共有する（src/types/pdf.ts が正準）。
export type PageBreakConfig = PdfPageBreakOptions;

export function buildPageBreakScript(config: PageBreakConfig): string {
	const { level, criterion } = config;
	// forceUpperBreak は内部仕様で常時 ON。
	// h1 設定時は上位が無いので forceLevel = 0。
	const forceLevel = level > 1 ? level - 1 : 0;
	const criterionJson = JSON.stringify(criterion);

	return `(function() {
  var maxLevel = ${level};
  var forceLevel = ${forceLevel};
  var criterion = ${criterionJson};
  var selectors = [];
  for (var i = 1; i <= maxLevel; i++) selectors.push('h' + i);
  var sel = selectors.join(',');

  // 1. A4 印刷領域高さ (257mm = 297mm - 20mm*2) をルーラー div で実測。
  //    CSS zoom 適用時、getBoundingClientRect() は zoom 後の座標を返すため、
  //    物理ページサイズに対する「zoomed 座標での 1 ページ分」を求める。
  var zoom = parseFloat(document.body.style.zoom) || 1;
  var ruler = document.createElement('div');
  ruler.style.cssText = 'position:absolute;visibility:hidden;width:0;height:257mm;';
  document.body.appendChild(ruler);
  var pageHeight = ruler.getBoundingClientRect().height / zoom;
  document.body.removeChild(ruler);
  if (pageHeight <= 0) return;

  // 2. 印刷レイアウトをシミュレーション。
  //    スクリーン幅 (800px) と印刷幅 (170mm≈644px) の差でテキスト折り返しが変わり
  //    セクション高さが過小評価されるのを防ぐため、body を印刷幅へ一時変更する。
  var origPadding = document.body.style.padding;
  var origWidth = document.body.style.width;
  var origMaxWidth = document.body.style.maxWidth;
  document.body.style.padding = '0';
  var pw = (170 / zoom) + 'mm';
  document.body.style.width = pw;
  document.body.style.maxWidth = pw;

  // 対象見出しの break-before を一時無効化し、自然レイアウトで高さ測定。
  // pre も印刷時と同じ折り返しモードにする。
  var style = document.createElement('style');
  style.textContent = sel + ' { break-before: auto !important; } pre { white-space: pre-wrap !important; word-wrap: break-word !important; }';
  document.head.appendChild(style);
  document.body.offsetHeight; // 強制レイアウト

  // safetyBuffer = 0: Chromium 単一 WebView では誤差が小さく、buffer を持たせる
  // 害（widow が増える）の方が大きいため。
  var safePageHeight = pageHeight;

  // 3. body 直下のブロック要素を列挙し各要素の占有高さを測定。
  //    UL / OL は直接子 LI に展開する（LI は break-inside: avoid だが
  //    UL/OL 自体は分割可能なため、LI 単位で追跡する必要がある）。
  var blockTags = {H1:1,H2:1,H3:1,H4:1,H5:1,H6:1,P:1,UL:1,OL:1,PRE:1,BLOCKQUOTE:1,TABLE:1,HR:1,IMG:1,DIV:1};
  var avoidBreakTags = {P:1,LI:1,PRE:1,BLOCKQUOTE:1,TABLE:1,IMG:1};
  var items = [];
  var ch = document.body.children;
  for (var i = 0; i < ch.length; i++) {
    var tag = ch[i].tagName;
    if (tag === 'UL' || tag === 'OL') {
      var lis = ch[i].children;
      for (var j = 0; j < lis.length; j++) {
        if (lis[j].tagName === 'LI') items.push(lis[j]);
      }
    } else if (tag in blockTags) {
      items.push(ch[i]);
    }
  }
  if (items.length === 0) {
    document.head.removeChild(style);
    document.body.style.padding = origPadding;
    document.body.style.width = origWidth;
    document.body.style.maxWidth = origMaxWidth;
    return;
  }

  // 各要素の占有高さ = 次要素 top までの距離（マージン含む）
  var heights = [];
  for (var i = 0; i < items.length; i++) {
    var top = items[i].getBoundingClientRect().top;
    var nextTop = (i + 1 < items.length)
      ? items[i + 1].getBoundingClientRect().top
      : document.body.getBoundingClientRect().bottom;
    heights.push(Math.max(0, nextTop - top));
  }

  // 4. ページフローをシミュレーション。
  //    - <hr class="pdf-pagebreak">: 著者マーカーで pageUsed = 0 にリセット
  //    - 上位見出し (forceLevel 以下): 常に改ページ
  //    - smart 対象見出し: criterion ごとの最小必要高さで現ページ残量を判定
  var pageUsed = 0;
  for (var i = 0; i < items.length; i++) {
    var el = items[i];
    var h = heights[i];
    var tag = el.tagName;
    var hMatch = tag.match(/^H([1-6])$/);
    var headingLevel = hMatch ? parseInt(hMatch[1], 10) : 0;

    // 著者マーカー: <hr class="pdf-pagebreak"> はページ送り
    if (tag === 'HR' && el.classList && el.classList.contains('pdf-pagebreak')) {
      pageUsed = 0;
      continue;
    }

    var isTargetHeading = headingLevel > 0 && headingLevel <= maxLevel;
    if (isTargetHeading) {
      if (forceLevel > 0 && headingLevel <= forceLevel) {
        // 上位見出し: smart 抑制対象外 → 常に改ページ
        pageUsed = 0;
      } else {
        // smart 抑制判定
        var need;
        if (criterion === 'compact') {
          // 見出し + 直後の最初の非見出しブロック
          var firstBlockH = 0;
          if (i + 1 < items.length) {
            var nextTag = items[i + 1].tagName;
            if (!/^H[1-6]$/.test(nextTag)) firstBlockH = heights[i + 1];
          }
          need = h + firstBlockH;
        } else {
          // section: 次の同位以上の見出しまで
          need = h;
          for (var k = i + 1; k < items.length; k++) {
            var kTag = items[k].tagName;
            var kMatch = kTag.match(/^H([1-6])$/);
            if (kMatch) {
              var kLevel = parseInt(kMatch[1], 10);
              if (kLevel <= maxLevel) break;
            }
            // 著者マーカーが途中にあれば section はそこで打ち切り
            if (kTag === 'HR' && items[k].classList && items[k].classList.contains('pdf-pagebreak')) break;
            need += heights[k];
          }
        }

        if (pageUsed + need <= safePageHeight) {
          el.setAttribute('data-no-break', '');
        } else {
          pageUsed = 0;
        }
      }
    }

    // pageUsed 更新（break-inside: avoid を考慮）
    var avoidBreak = (tag in avoidBreakTags);
    if (avoidBreak && pageUsed > 0 && pageUsed + h > pageHeight) {
      pageUsed = h;
    } else {
      pageUsed += h;
    }
    while (pageUsed >= pageHeight) {
      pageUsed -= pageHeight;
    }
  }

  // 5. 一時スタイル / レイアウト復元
  document.head.removeChild(style);
  document.body.style.padding = origPadding;
  document.body.style.width = origWidth;
  document.body.style.maxWidth = origMaxWidth;
})();`;
}
