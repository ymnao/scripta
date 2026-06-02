/**
 * PDF 改ページ補正スクリプト (#93)。
 *
 * 印刷直前 (fonts.ready + idle 後) に main の `executeJavaScript` 経由で
 * webContents 内で実行される。ユーザ選択の smart-level / criterion を meta tag
 * 経由で受け取り、各セクションの実 layout 高さを測定して「現ページ残量に
 * 収まらない section」に inline `style.breakBefore = 'page'` を強制注入する。
 *
 * Chromium の `break-inside: avoid` は wrapper 要素に対して unreliable (子要素間で
 * break して wrapper の中割れを許容する)。明示的な inline `break-before` は確実に
 * 尊重されるため、これで section の中割れを完全に防ぐ。
 *
 * # meta tag contract (renderer が emit)
 *
 * - `<meta name="scripta-pdf-smart-level" content="1|2|3">`: 区切り対象見出しレベル。
 *   省略時はスクリプトが body 直下の見出し分布から auto-detect する。
 * - `<meta name="scripta-pdf-criterion" content="section|compact">`: keep 基準。
 *   - section: 見出し + 次の同位以下見出しまでを 1 単位として keep-together
 *   - compact: 見出し + 直後ブロックのみ keep (中割れ許容、詰めた配置)
 */

/** `executeJavaScript` で実行する文字列を返す。pure function (テスト容易性のため)。 */
export function buildSectionBreakScript(): string {
	return `(function() {
  var result = {
    headingCounts: { h1: 0, h2: 0, h3: 0, h4: 0, h5: 0, h6: 0 },
    smartLevelUsed: null,
    criterion: 'section',
    sectionsTotal: 0,
    sectionsBroken: 0,
    errors: []
  };

  try {
    // smart-level meta が無ければ script は何もしない (smart=false / level=none では
    // renderer が meta を emit しない設計なので、これが「smart 改ページ OFF」の signal)。
    var levelMeta = document.querySelector('meta[name="scripta-pdf-smart-level"]');
    if (!levelMeta) return JSON.stringify(result);
    var requestedLevel = parseInt(levelMeta.getAttribute('content') || '', 10);

    var criterionMeta = document.querySelector('meta[name="scripta-pdf-criterion"]');
    var criterion = (criterionMeta && criterionMeta.getAttribute('content')) || 'section';
    if (criterion !== 'compact' && criterion !== 'section') criterion = 'section';
    result.criterion = criterion;

    // force-level meta: CSS で break-before:page が当たる上位見出しの最大レベル。
    // この値以下のレベルの見出しに遭遇したら virtualY を次ページ頭へジャンプさせて、
    // CSS forced break を simulation に反映する (renderer の buildForceBreakSelectors と
    // 同じ集合を表す)。
    var forceMeta = document.querySelector('meta[name="scripta-pdf-force-level"]');
    var forceLevel = forceMeta ? parseInt(forceMeta.getAttribute('content') || '0', 10) : 0;
    if (!(forceLevel >= 0 && forceLevel <= 6)) forceLevel = 0;

    // body 直下の見出し分布を 1-pass で測定
    var bodyChildren = document.body.children;
    for (var bi = 0; bi < bodyChildren.length; bi++) {
      var tag = bodyChildren[bi].tagName;
      if (tag.length === 2 && tag.charAt(0) === 'H') {
        var d = parseInt(tag.charAt(1), 10);
        if (d >= 1 && d <= 6) result.headingCounts['h' + d]++;
      }
    }

    // smart-level の解決: meta 指定 & その level が body に複数あればそれを採用、
    // 無ければ「複数回現れる最も浅いレベル (h2 > h3 > h1 > h4)」で auto-detect。
    // ユーザが選んだ level がドキュメント構造と合わないとき (例: level=h2 だが doc に
    // h2 が無く h3 だけ) は fallback する。
    var smartLevel = null;
    if (requestedLevel >= 1 && requestedLevel <= 6 && result.headingCounts['h' + requestedLevel] >= 2) {
      smartLevel = requestedLevel;
    } else {
      var hc = result.headingCounts;
      if (hc.h2 >= 2) smartLevel = 2;
      else if (hc.h3 >= 2) smartLevel = 3;
      else if (hc.h1 >= 2) smartLevel = 1;
      else if (hc.h4 >= 2) smartLevel = 4;
    }
    result.smartLevelUsed = smartLevel;
    if (smartLevel === null) return JSON.stringify(result);

    // ページ高さ (A4 - 上下 20mm margin = 257mm) を実測。
    // ruler は body 内に置くと body.style.zoom が適用されるため、ruler 高さを
    // (257 / zoom) mm に補正して rendered 値が常に物理 257mm 相当の viewport px になるようにする。
    var zoom = parseFloat(document.body.style.zoom) || 1;
    var ruler = document.createElement('div');
    ruler.style.cssText = 'position:absolute;visibility:hidden;width:0;height:' + (257 / zoom) + 'mm;';
    document.body.appendChild(ruler);
    var pageHeight = ruler.getBoundingClientRect().height;
    document.body.removeChild(ruler);
    if (pageHeight <= 0) {
      result.errors.push('pageHeight <= 0');
      return JSON.stringify(result);
    }
    // 5% safety buffer は font hinting / subpixel rendering 程度の最小 drift 吸収用。
    var safetyBuffer = pageHeight * 0.05;

    // body を印刷幅 (170mm) に揃えてから measure (screen 幅と print 幅で text wrap が
    // 変わると section 高さが drift するため)。
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
      // heights は「次要素 top - この要素 top」を使うことで margin collapse 後の
      // 実際のブロック間距離 (= virtualY 累積に必要な値) が自動で含まれる。
      var heights = [];
      var bodyBottom = document.body.getBoundingClientRect().bottom;
      for (var i = 0; i < children.length; i++) {
        var top = children[i].getBoundingClientRect().top;
        var nextTop = i + 1 < children.length ? children[i + 1].getBoundingClientRect().top : bodyBottom;
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

        // CSS で break-before: page が当たる上位見出し (h1..h{forceLevel}) → virtualY を
        // 次ページ頭にジャンプ。これを入れないと「自然レイアウトの高さ累積」と「実 print
        // の paginated layout」がずれて、後続の smart-level 判定がページ境界を誤認する。
        if (forceLevel > 0) {
          var ft = item.tagName;
          if (ft.length === 2 && ft.charAt(0) === 'H') {
            var fhLvl = parseInt(ft.charAt(1), 10);
            if (fhLvl >= 1 && fhLvl <= forceLevel) {
              if (virtualY > 0) {
                var inPageF = virtualY % pageHeight;
                if (inPageF > 0) virtualY += pageHeight - inPageF;
              }
              virtualY += h;
              continue;
            }
          }
        }

        // smart-level 見出し → criterion に応じて needed height を算出
        if (item.tagName === 'H' + smartLevel) {
          result.sectionsTotal++;

          var neededH;
          if (criterion === 'compact') {
            // compact: 見出し + 直後の最初の非見出しブロックのみ keep。
            neededH = h;
            if (i + 1 < children.length) {
              var first = children[i + 1];
              if (!/^H[1-6]$/.test(first.tagName)) {
                neededH += heights[i + 1];
              }
            }
          } else {
            // section: 見出し + 次の同位以下見出し or HR pagebreak までの全コンテンツ。
            neededH = h;
            for (var j = i + 1; j < children.length; j++) {
              var nx = children[j];
              if (/^H[1-6]$/.test(nx.tagName)) {
                var nxLvl = parseInt(nx.tagName.charAt(1), 10);
                if (nxLvl <= smartLevel) break;
              }
              if (
                nx.tagName === 'HR' &&
                nx.classList &&
                nx.classList.contains('pdf-pagebreak')
              ) break;
              neededH += heights[j];
            }
          }

          var inPage = virtualY % pageHeight;
          var remaining = pageHeight - inPage;
          // 現ページに収まらない && 1 ページに収まる && 既にページ途中
          if (
            inPage > 0 &&
            (neededH + safetyBuffer) > remaining &&
            neededH <= pageHeight
          ) {
            item.style.breakBefore = 'page';
            item.style.pageBreakBefore = 'always';
            virtualY += remaining;
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
