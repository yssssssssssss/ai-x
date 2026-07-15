#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
render_journey_map.py — 把一份「旅程图 JSON spec」渲染成自包含、可视化的 HTML 体验旅程图。

用法:
    python render_journey_map.py <spec.json> <out.html>

设计意图（见 journey-map skill）：
- 旅程图是给需求方/产品看的可视化产物，纯 markdown 表格可读性差、不便直接用。
- 本脚本把 skill 起草好的结构化数据（JSON spec）渲染成一张样式统一的图：
  阶段为列、维度为行（目标/行为/触点/想法/情绪曲线/痛点·需求/机会点），
  情绪行用 SVG 曲线 + emoji 呈现，痛点/机会点行有色彩强调；多类用户多张图纵向排布并带顶部导航。
- 渲染纯靠 Python 标准库、零外部依赖；产出单一 .html，双击即开，可「打印为 PDF」分享。

spec.json 结构（字段缺失会优雅降级；详见 references/journey-map-skeleton.md）：
{
  "project_title": "洗衣机购买体验旅程图",
  "subtitle": "线上：从想买到收货安装",            # 可选
  "disclaimer": "本图为单机分析初稿，机会点待团队共创；原声已匿名。",  # 可选，顶部提示条
  "maps": [
    {
      "id": "①",                                  # 可选，序号徽标
      "type_name": "全面研究型（置办新家）",
      "mindset": "长期要用、一步到位买个好的",       # 可选，引号心智
      "scenario": "新房装修配齐家电 / 结婚置办新家",  # 可选
      "support": "用户A、用户E（已匿名）",           # 可选
      "stages": ["需求产生", "信息收集", "挑选对比", "下单付款", "收货安装"],
      "rows": [
        {"key": "goal",        "label": "目标 Goals",            "cells": ["…","…","…","…","…"]},
        {"key": "action",      "label": "行为 Actions",          "cells": [...]},
        {"key": "touchpoint",  "label": "触点 Touchpoints",      "cells": [...]},
        {"key": "thought",     "label": "想法 Thoughts",         "cells": [...]},
        {"key": "pain",        "label": "痛点/需求 Pain Points", "cells": [...]},
        {"key": "opportunity", "label": "机会点 Opportunities",  "cells": [...]}
      ],
      "emotion": {                                  # 可选；只标有情绪证据的环节，无证据填 null
        "levels": [3, 1, 2, 2, 5],                  # 1=低谷 … 5=高峰；null=该环节无情绪证据
        "emojis": ["🙂", "😣", "🙁", "🙁", "😀"],
        "notes":  ["中高", "低谷", "中低", "中低", "高峰"]
      },
      "footnote": "情绪与机会点基于 draft 正典；A/E 各 1 人为初步假设，需扩样；机会点待共创"
    }
  ],
  "priorities": [                                   # 可选，跨图的需求/机会点优先级清单
    {"need": "型号差异不透明", "stage": "挑选对比", "freq": "2/5",
     "priority": "高", "opportunity": "型号差异结构化对比表"}
  ]
}
"""
import sys, json, html


# ---- 行类型 → 配色（在截图蓝基础上优化：痛点偏红、机会点偏绿、想法偏暖） ----
ROW_STYLE = {
    "goal":        {"accent": "#2f6bff", "bg": "#f5f8ff"},
    "action":      {"accent": "#5b6b8c", "bg": "#ffffff"},
    "touchpoint":  {"accent": "#7c4dff", "bg": "#faf7ff"},
    "thought":     {"accent": "#d6a700", "bg": "#fffdf2", "italic": True},
    "pain":        {"accent": "#ef4444", "bg": "#fff6f6"},
    "need":        {"accent": "#ef4444", "bg": "#fff6f6"},
    "opportunity": {"accent": "#22a564", "bg": "#f3fdf7"},
    "demand":      {"accent": "#0ea5b7", "bg": "#f2fdff"},  # 诉求
    "_default":    {"accent": "#5b6b8c", "bg": "#ffffff"},
}

PRIORITY_CHIP = {
    "高": ("#fee2e2", "#b91c1c"),
    "中": ("#fef3c7", "#92660a"),
    "低": ("#e5e7eb", "#4b5563"),
}


def esc(s):
    if s is None:
        return ""
    return html.escape(str(s)).replace("\n", "<br>")


def render_cell(c):
    """单元格内容：列表 -> 分条 bullet；字符串 -> 原样（\\n 转 <br>）。
    内容尽量丰富、多要点时务必用列表分条，避免一句话含糊歧义。"""
    if isinstance(c, (list, tuple)):
        items = "".join("<li>%s</li>" % esc(x) for x in c if str(x).strip() != "")
        return '<ul class="jm-li">%s</ul>' % items if items else ""
    return esc(c)


def emotion_band_svg(emotion, n_stages):
    """情绪曲线：在 colspan 跨全部阶段列的单元格内画 SVG 折线 + emoji + 备注，天然与列对齐。"""
    levels = (emotion or {}).get("levels") or []
    emojis = (emotion or {}).get("emojis") or []
    notes = (emotion or {}).get("notes") or []
    n = n_stages
    if n == 0:
        return ""
    colw = 200
    W, H = n * colw, 170
    top, bot = 30, 120  # level 5 -> y=top, level 1 -> y=bot

    def yat(lv):
        lv = max(1, min(5, lv))
        return bot - (lv - 1) / 4.0 * (bot - top)

    xs = [int((i + 0.5) * colw) for i in range(n)]
    pts = []
    for i in range(n):
        lv = levels[i] if i < len(levels) else None
        if lv is None:
            pts.append(None)
        else:
            pts.append((xs[i], yat(lv)))

    parts = ['<svg viewBox="0 0 %d %d" preserveAspectRatio="xMidYMid meet" '
             'style="width:100%%;height:150px;display:block">' % (W, H)]
    # 网格基线
    parts.append('<line x1="0" y1="%d" x2="%d" y2="%d" stroke="#e6ebf5" stroke-width="1"/>' % (bot + 18, W, bot + 18))
    # 折线（跳过无证据的 null 段，断开）
    seg = []
    polylines = []
    for p in pts:
        if p is None:
            if len(seg) >= 2:
                polylines.append(seg)
            seg = []
        else:
            seg.append(p)
    if len(seg) >= 2:
        polylines.append(seg)
    for s in polylines:
        d = " ".join("%d,%d" % (x, int(y)) for x, y in s)
        parts.append('<polyline points="%s" fill="none" stroke="#2f6bff" stroke-width="3" '
                     'stroke-linejoin="round" stroke-linecap="round"/>' % d)
    # 点 + emoji + note
    for i in range(n):
        x = xs[i]
        p = pts[i]
        if p is None:
            parts.append('<text x="%d" y="%d" text-anchor="middle" font-size="13" fill="#9aa4b8">—</text>' % (x, (top + bot) // 2))
            parts.append('<text x="%d" y="%d" text-anchor="middle" font-size="12" fill="#9aa4b8">无情绪证据</text>' % (x, bot + 40))
            continue
        _, y = p
        em = emojis[i] if i < len(emojis) else ""
        nt = notes[i] if i < len(notes) else ""
        parts.append('<circle cx="%d" cy="%d" r="6" fill="#2f6bff"/>' % (x, int(y)))
        parts.append('<text x="%d" y="%d" text-anchor="middle" font-size="30">%s</text>' % (x, int(y) - 16, esc(em)))
        parts.append('<text x="%d" y="%d" text-anchor="middle" font-size="14" fill="#3a4a6b">%s</text>' % (x, bot + 40, esc(nt)))
    parts.append("</svg>")
    return "".join(parts)


def render_map(m):
    stages = m.get("stages") or []
    n = len(stages)
    out = []
    out.append('<section class="jm-card" id="map-%s">' % esc(m.get("id", "")))
    # 头部
    badge = ('<span class="jm-badge">%s</span>' % esc(m["id"])) if m.get("id") else ""
    out.append('<div class="jm-head">')
    out.append('<div class="jm-title">%s%s</div>' % (badge, esc(m.get("type_name", "用户旅程图"))))
    if m.get("mindset"):
        out.append('<div class="jm-mindset">“%s”</div>' % esc(m["mindset"]))
    meta_bits = []
    if m.get("scenario"):
        meta_bits.append("适用场景：" + esc(m["scenario"]))
    if m.get("support"):
        meta_bits.append("支撑：" + esc(m["support"]))
    if meta_bits:
        out.append('<div class="jm-meta">%s</div>' % "　｜　".join(meta_bits))
    out.append('</div>')

    # 表格
    out.append('<div class="jm-scroll"><table class="jm-table"><colgroup>')
    out.append('<col style="width:130px">')
    for _ in range(n):
        out.append('<col>')
    out.append('</colgroup>')
    # 阶段表头
    out.append('<thead><tr><th class="jm-corner">阶段 Stages</th>')
    for s in stages:
        out.append('<th class="jm-stage">%s</th>' % esc(s))
    out.append('</tr></thead><tbody>')
    # 维度行
    for row in m.get("rows") or []:
        st = ROW_STYLE.get(row.get("key"), ROW_STYLE["_default"])
        italic = "font-style:italic;" if st.get("italic") else ""
        out.append('<tr>')
        out.append('<th class="jm-rowlabel" style="border-left:5px solid %s">%s</th>' % (st["accent"], esc(row.get("label", ""))))
        cells = row.get("cells") or []
        for i in range(n):
            c = cells[i] if i < len(cells) else ""
            out.append('<td style="background:%s;%s">%s</td>' % (st["bg"], italic, render_cell(c)))
        out.append('</tr>')
    # 情绪行（SVG 跨列）
    if m.get("emotion"):
        out.append('<tr><th class="jm-rowlabel" style="border-left:5px solid #2f6bff">情绪 Emotions</th>')
        out.append('<td class="jm-emotion" colspan="%d">%s</td></tr>' % (n, emotion_band_svg(m["emotion"], n)))
    out.append('</tbody></table></div>')

    if m.get("footnote"):
        out.append('<div class="jm-foot">⚠ %s</div>' % esc(m["footnote"]))
    out.append('</section>')
    return "".join(out)


def render_priorities(priorities):
    if not priorities:
        return ""
    out = ['<section class="jm-card"><div class="jm-head"><div class="jm-title">需求与机会点优先级</div></div>',
           '<div class="jm-scroll"><table class="jm-table jm-prio"><thead><tr>'
           '<th>痛点/需求</th><th>阶段</th><th>频次</th><th>优先级</th><th>对应机会点</th>'
           '</tr></thead><tbody>']
    for p in priorities:
        bg, fg = PRIORITY_CHIP.get(str(p.get("priority", "")).strip(), ("#e5e7eb", "#4b5563"))
        chip = '<span class="jm-chip" style="background:%s;color:%s">%s</span>' % (bg, fg, esc(p.get("priority", "")))
        out.append('<tr><td>%s</td><td>%s</td><td>%s</td><td>%s</td><td>%s</td></tr>' % (
            render_cell(p.get("need", "")), esc(p.get("stage", "")), esc(p.get("freq", "")), chip, render_cell(p.get("opportunity", ""))))
    out.append('</tbody></table></div></section>')
    return "".join(out)


def render(spec):
    maps = spec.get("maps") or []
    nav = ""
    if len(maps) > 1:
        links = " ".join('<a href="#map-%s">%s %s</a>' % (esc(m.get("id", i)), esc(m.get("id", "")), esc(m.get("type_name", "")))
                         for i, m in enumerate(maps))
        nav = '<nav class="jm-nav">%s</nav>' % links
    body = nav + "".join(render_map(m) for m in maps) + render_priorities(spec.get("priorities"))

    title = esc(spec.get("project_title", "用户体验旅程图"))
    sub = ('<div class="jm-sub">%s</div>' % esc(spec["subtitle"])) if spec.get("subtitle") else ""
    disc = ('<div class="jm-disclaimer">%s</div>' % esc(spec["disclaimer"])) if spec.get("disclaimer") else ""

    return TEMPLATE.format(title=title, sub=sub, disc=disc, body=body)


TEMPLATE = """<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{title}</title>
<style>
  :root {{ --ink:#1f2937; --muted:#6b7280; --line:#e6ebf5; --blue:#2f6bff; }}
  * {{ box-sizing:border-box; }}
  body {{ margin:0; padding:28px 22px 60px; background:#eef2f9;
         font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","Microsoft YaHei",Roboto,Helvetica,Arial,sans-serif;
         color:var(--ink); line-height:1.5; }}
  .jm-wrap {{ max-width:1280px; margin:0 auto; }}
  .jm-maintitle {{ font-size:26px; font-weight:800; letter-spacing:.5px; }}
  .jm-sub {{ color:var(--muted); margin-top:4px; font-size:15px; }}
  .jm-disclaimer {{ margin:14px 0 8px; padding:10px 14px; background:#fff8e6; border:1px solid #ffe2a8;
                    border-radius:10px; color:#7a5a00; font-size:13px; }}
  .jm-nav {{ margin:16px 0; display:flex; flex-wrap:wrap; gap:8px; }}
  .jm-nav a {{ text-decoration:none; font-size:13px; padding:6px 12px; background:#fff; border:1px solid var(--line);
               border-radius:999px; color:#2b4a8a; }}
  .jm-nav a:hover {{ background:#eaf1ff; }}
  .jm-card {{ background:#fff; border:1px solid var(--line); border-radius:16px; padding:18px 18px 16px;
              margin:18px 0; box-shadow:0 2px 14px rgba(34,53,94,.06); }}
  .jm-head {{ margin-bottom:12px; }}
  .jm-title {{ font-size:19px; font-weight:800; display:flex; align-items:center; gap:10px; }}
  .jm-badge {{ display:inline-flex; align-items:center; justify-content:center; min-width:30px; height:30px; padding:0 8px;
               background:linear-gradient(135deg,#2f6bff,#5b8cff); color:#fff; border-radius:9px; font-size:16px; }}
  .jm-mindset {{ margin-top:6px; color:#2b4a8a; font-size:15px; font-weight:600; }}
  .jm-meta {{ margin-top:4px; color:var(--muted); font-size:13px; }}
  .jm-scroll {{ overflow-x:auto; border-radius:12px; border:1px solid var(--line); }}
  table.jm-table {{ border-collapse:collapse; width:100%; min-width:760px; table-layout:fixed; }}
  .jm-table th, .jm-table td {{ border:1px solid var(--line); padding:9px 11px; vertical-align:top;
                                font-size:13px; word-break:break-word; }}
  .jm-corner {{ background:#2f6bff; color:#fff; font-weight:700; position:sticky; left:0; z-index:2; }}
  .jm-stage {{ background:#3b6fe0; color:#fff; font-weight:700; text-align:center; font-size:14px; }}
  .jm-rowlabel {{ background:#eef3ff; color:#23408f; font-weight:700; text-align:left; position:sticky; left:0; z-index:1; }}
  .jm-emotion {{ background:#fafbff; padding:6px 8px; }}
  .jm-li {{ margin:0; padding-left:17px; }}
  .jm-li li {{ margin:3px 0; }}
  .jm-table td {{ line-height:1.45; }}
  .jm-foot {{ margin-top:10px; color:#9a6a00; font-size:12px; background:#fffdf2; border-left:3px solid #f0c000;
              padding:6px 10px; border-radius:4px; }}
  .jm-prio td, .jm-prio th {{ text-align:left; }}
  .jm-prio thead th {{ background:#3b6fe0; color:#fff; }}
  .jm-chip {{ display:inline-block; padding:2px 12px; border-radius:999px; font-weight:700; font-size:12px; }}
  .jm-hint {{ color:var(--muted); font-size:12px; margin-top:8px; }}
  @media print {{
    body {{ background:#fff; padding:0; }}
    .jm-card {{ box-shadow:none; border-color:#ccc; break-inside:avoid; }}
    .jm-nav {{ display:none; }}
  }}
</style></head>
<body><div class="jm-wrap">
  <div class="jm-maintitle">{title}</div>
  {sub}
  {disc}
  {body}
  <div class="jm-hint">提示：本页为自包含 HTML，可直接在浏览器打开；用浏览器「打印 → 另存为 PDF」即可导出分享。</div>
</div></body></html>
"""


def main():
    if len(sys.argv) != 3:
        print("用法: python render_journey_map.py <spec.json> <out.html>", file=sys.stderr)
        sys.exit(2)
    spec_path, out_path = sys.argv[1], sys.argv[2]
    with open(spec_path, encoding="utf-8") as f:
        spec = json.load(f)
    html_str = render(spec)
    with open(out_path, "w", encoding="utf-8") as f:
        f.write(html_str)
    n_maps = len(spec.get("maps") or [])
    print("OK: 渲染 %d 张旅程图 -> %s" % (n_maps, out_path))


if __name__ == "__main__":
    main()
