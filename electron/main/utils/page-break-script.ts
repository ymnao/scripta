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

    // smart-level の解決:
    //   1. meta 指定の level に複数見出しがあればそれを採用
    //   2. 不在ならば「複数回現れる最も浅いレベル」で auto-detect (h2 > h3 > h1 > h4)
    //
    // 一度「ユーザ契約優先」で shallow-only fallback にしたが (レビュー指摘)、
    // それだと「h1=タイトル 1 個 + h3=section 多数」(typical markdown スタイル) で
    // smartLevel=null になって中割れ放置という別の UX 違反が出たため、shallow / deeper
    // 両方向 fallback に戻した。ユーザの「h2 まで」選択は「該当見出しがあれば」honor
    // するが、ドキュメント構造が合わなければ近いレベルへ自動補正する。dialog 側で
    // この挙動を label に明記する手もあるが、現状は実用優先で auto-detect 任せ。
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

    // fallback で smart level が下がった場合 (例: requested=3 → smartLevel=2)、
    // renderer 由来の forceLevel (=2) のままだと loop が h2 を「上位 force-break」として
    // 処理して continue し、smart-suppression に入らず fallback の意味が消える。
    // forceLevel は常に smartLevel より浅い側 (= smartLevel - 1 以下) に clamp する。
    if (forceLevel >= smartLevel) forceLevel = smartLevel - 1;

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
      // body 直下を走査しつつ、UL/OL は LI に展開する。CSS で li に break-inside: avoid
      // が当たっているため、UL 全体を 1 つの自然高さで足すと最終 LI が実 print で次ページ
      // に押し出される挙動を見逃す。LI 単位の高さで累積すれば LI 押し出しを正しく simulate
      // できる。
      var children = [];
      var bodyDirectChildren = document.body.children;
      for (var ci = 0; ci < bodyDirectChildren.length; ci++) {
        var c = bodyDirectChildren[ci];
        if (c.tagName === 'UL' || c.tagName === 'OL') {
          var lis = c.children;
          for (var li = 0; li < lis.length; li++) {
            if (lis[li].tagName === 'LI') children.push(lis[li]);
          }
        } else {
          children.push(c);
        }
      }

      // heights は「次要素 top - この要素 top」を使うことで margin collapse 後の
      // 実際のブロック間距離 (= virtualY 累積に必要な値) が自動で含まれる。
      var heights = [];
      var bodyBottom = document.body.getBoundingClientRect().bottom;
      for (var i = 0; i < children.length; i++) {
        var top = children[i].getBoundingClientRect().top;
        var nextTop = i + 1 < children.length ? children[i + 1].getBoundingClientRect().top : bodyBottom;
        heights.push(Math.max(0, nextTop - top));
      }

      // CSS で break-inside: avoid を当てている要素集合 (export.ts の @media print と同期)。
      // 現ページに収まらない場合 Chromium は次ページに送るので、virtualY 累積でも同じ
      // 挙動をシミュレートして実 print の paginated layout と一致させる。LI も含める
      // (UL/OL を expand したため、各 LI が直接 children に並ぶ)。
      function isAvoidBreakInside(el) {
        var t = el.tagName;
        if (
          t === 'P' || t === 'PRE' || t === 'BLOCKQUOTE' ||
          t === 'TABLE' || t === 'IMG' || t === 'LI'
        ) return true;
        return !!(el.classList && el.classList.contains('mermaid-diagram'));
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

        // break-inside: avoid の要素は現ページに収まらない場合、Chromium が次ページに
        // 送るのでそれを virtualY にも反映させる。これを入れないと後続の smart-level
        // 判定が「実 print より早い段階」で remaining を見積もり、必要な force-break を
        // 見逃す。
        if (isAvoidBreakInside(item)) {
          var inPageA = virtualY % pageHeight;
          var remainingA = pageHeight - inPageA;
          if (inPageA > 0 && h > remainingA && h <= pageHeight) {
            virtualY += remainingA; // 次ページ頭へジャンプしてからこの要素を配置
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
