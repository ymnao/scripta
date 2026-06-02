/**
 * PDF 改ページ補正スクリプト (#93) — minimal inline break-before injection (v5)。
 *
 * # 経緯
 *
 * v1〜v4 はすべて wrapper（`<section>` / `<table>`）に CSS hint を当てる方式だったが、
 * Chromium はどの wrapper 形式でも `break-inside` を「各 wrapper を独立した新ページに送る」
 * と過剰解釈する quirk があり、無駄空白だらけの結果になっていた。
 *
 * # 設計 (v5: wrapper を完全に捨てる)
 *
 * - **wrapper を使わない**。renderer 側で wrap されていれば DOM 操作で unwrap する。
 * - smart-level の見出し（h2 / h3 等）を自動検出し、各見出しを起点とする「section」の
 *   レンダリング高さを実測。
 * - 「現ページ残量に section が収まらない」ものに **inline `break-before: page` を
 *   見出し自身に直接注入**。Chromium は inline forced break を確実に尊重する。
 *
 * # buffer
 *
 * 15% safety buffer (≈38mm @ A4)。drift があっても sec4 のような小 section が
 * 現ページに収まる誤判定を防げる。逆に大きすぎると section 3 のような中サイズの
 * section まで force-break してしまうので、15% が経験則上のスイートスポット。
 *
 * # 診断
 *
 * 走査結果を JSON で return:
 *   - unwrapped: 削除した `.pdf-section-keep` wrapper 数
 *   - headingCounts: body 直下の h1〜h6 出現数
 *   - smartLevelUsed: 採用した smart level
 *   - sectionsTotal: 検出した section 数
 *   - sectionsBroken: break-before 注入した section 数
 *   - errors: 例外メッセージ
 */

/**
 * `executeJavaScript` で実行する文字列を返す。pure function (テスト容易性のため)。
 */
export function buildSectionBreakScript(): string {
	return `(function() {
  var result = {
    unwrapped: 0,
    headingCounts: { h1: 0, h2: 0, h3: 0, h4: 0, h5: 0, h6: 0 },
    smartLevelUsed: null,
    sectionsTotal: 0,
    sectionsBroken: 0,
    errors: []
  };

  try {
    // 1. 既存の .pdf-section-keep wrapper を unwrap (子要素を親に flatten)
    // renderer 側で wrap された場合の overcaution 源を削除する。
    var wrappers = document.querySelectorAll('.pdf-section-keep');
    result.unwrapped = wrappers.length;
    for (var wi = 0; wi < wrappers.length; wi++) {
      var w = wrappers[wi];
      var p = w.parentNode;
      if (!p) continue;
      while (w.firstChild) p.insertBefore(w.firstChild, w);
      p.removeChild(w);
    }

    // 2. body 直下の見出し分布を測定
    for (var lvl = 1; lvl <= 6; lvl++) {
      result.headingCounts['h' + lvl] =
        document.querySelectorAll('body > h' + lvl).length;
    }
    var hc = result.headingCounts;
    var smartLevel = null;
    if (hc.h2 >= 2) smartLevel = 2;
    else if (hc.h3 >= 2) smartLevel = 3;
    else if (hc.h1 >= 2) smartLevel = 1;
    else if (hc.h4 >= 2) smartLevel = 4;
    result.smartLevelUsed = smartLevel;
    if (smartLevel === null) return JSON.stringify(result);

    // 3. ページ高さ (A4 - 上下 20mm margin = 257mm) を実測
    var zoom = parseFloat(document.body.style.zoom) || 1;
    var ruler = document.createElement('div');
    ruler.style.cssText = 'position:absolute;visibility:hidden;width:0;height:257mm;';
    document.body.appendChild(ruler);
    var pageHeight = ruler.getBoundingClientRect().height;
    document.body.removeChild(ruler);
    if (pageHeight <= 0) {
      result.errors.push('pageHeight <= 0');
      return JSON.stringify(result);
    }
    // 10% safety buffer。v5.1 で margin drift を解消したことで script の
    // measurement 精度が向上したため、buffer を 15% → 10% に詰めても中割れリスクは低い。
    // 不要な force-break で空白を増やすデメリットの方が大きいので攻めの設定 (#93 v5.2)。
    var safetyBuffer = pageHeight * 0.1;

    // 4. body を印刷幅 (170mm) に揃えてから measure
    var origPadding = document.body.style.padding;
    var origWidth = document.body.style.width;
    var origMaxWidth = document.body.style.maxWidth;
    document.body.style.padding = '0';
    var pw = (170 / zoom) + 'mm';
    document.body.style.width = pw;
    document.body.style.maxWidth = pw;
    var styleEl = document.createElement('style');
    styleEl.textContent = 'pre { white-space: pre-wrap !important; word-wrap: break-word !important; }';
    document.head.appendChild(styleEl);
    document.body.offsetHeight; // 強制 reflow

    try {
      var children = Array.prototype.slice.call(document.body.children);
      // heights は「element box の高さ」ではなく「次要素 top までの距離」を使う。
      // この方法で **ブロック間の上下マージン** が暗黙的に含まれ、virtualY の累積が
      // 実 print layout と一致する。margin collapse が起きていても次要素の top を基準
      // にすれば自動で正しい (旧 v2 で確立した方式、v5 で見落としていた #93 v5.1)。
      var heights = [];
      var bodyBottom = document.body.getBoundingClientRect().bottom;
      for (var i = 0; i < children.length; i++) {
        var top = children[i].getBoundingClientRect().top;
        var nextTop =
          i + 1 < children.length ? children[i + 1].getBoundingClientRect().top : bodyBottom;
        heights.push(Math.max(0, nextTop - top));
      }

      var virtualY = 0;
      for (var i = 0; i < children.length; i++) {
        var item = children[i];
        var h = heights[i];

        // pagebreak 著者マーカー (hr.pdf-pagebreak)
        var isMarker =
          item.tagName === 'HR' &&
          item.classList &&
          item.classList.contains('pdf-pagebreak');
        if (isMarker && virtualY > 0) {
          var inPageMarker = virtualY % pageHeight;
          if (inPageMarker > 0) virtualY += pageHeight - inPageMarker;
          virtualY += h;
          continue;
        }

        // smart-level 見出し → section 範囲を計算して break-before 判定
        if (item.tagName === 'H' + smartLevel) {
          result.sectionsTotal++;

          // section 範囲: この見出しから「次の同位以下見出し or HR pagebreak」まで
          var sectionH = h;
          for (var j = i + 1; j < children.length; j++) {
            var nx = children[j];
            // 次の見出しが同位以下なら section 終端
            if (/^H[1-6]$/.test(nx.tagName)) {
              var nxLvl = parseInt(nx.tagName.charAt(1), 10);
              if (nxLvl <= smartLevel) break;
            }
            // pagebreak marker も終端
            if (
              nx.tagName === 'HR' &&
              nx.classList &&
              nx.classList.contains('pdf-pagebreak')
            ) break;
            sectionH += heights[j];
          }

          var inPage = virtualY % pageHeight;
          var remaining = pageHeight - inPage;
          // section が現ページに収まらない && 1 ページに収まる && 既にページ途中
          if (
            inPage > 0 &&
            (sectionH + safetyBuffer) > remaining &&
            sectionH <= pageHeight
          ) {
            item.style.breakBefore = 'page';
            item.style.pageBreakBefore = 'always';
            virtualY += remaining; // 次ページ頭にジャンプ
            result.sectionsBroken++;
          }
        }

        virtualY += h;
      }
    } finally {
      document.head.removeChild(styleEl);
      document.body.style.padding = origPadding;
      document.body.style.width = origWidth;
      document.body.style.maxWidth = origMaxWidth;
    }
  } catch (e) {
    result.errors.push(String(e && e.message ? e.message : e));
  }
  return JSON.stringify(result);
})();`;
}
