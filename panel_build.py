#!/usr/bin/env python3
"""生成 admin.html：WB 反代看板的配色令牌 + 本站自己的布局样式。

为什么不直接搬 dashboard.html 的 <style>：那 7 个样式块是给「侧栏 + 52px 顶栏 + next 壳」
那套 DOM 写的，搬到别的 markup 上会出现 KPI 竖着排、<main> 掉进 216px 第一列。
所以这里只借它的 :root 令牌（保证配色 1:1），布局按令牌重写。
"""
from pathlib import Path

ROOT = Path(__file__).resolve().parent
REF = ROOT.parent / 'wb_ref'
tokens = (REF / 'wb_tokens.css').read_text(encoding='utf-8')
shell = (ROOT / 'panel_app2.html').read_text(encoding='utf-8')

style = r"""
""" + tokens + r"""
*{box-sizing:border-box}
html,body{margin:0;min-height:100%}
body{background:var(--bg);color:var(--fg);font:13px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;-webkit-font-smoothing:antialiased}
a{color:var(--accent);text-decoration:none}
a:hover{text-decoration:underline}

/* ---------- 外壳 ---------- */
.console-shell{display:grid;grid-template-columns:216px minmax(0,1fr);min-height:100vh}
.console-sidebar{position:sticky;top:0;height:100vh;display:flex;flex-direction:column;background:var(--panel);border-right:1px solid var(--line);overflow-y:auto}
.console-nav-head{display:flex;align-items:center;gap:8px;padding:16px 16px 13px;border-bottom:1px solid var(--line)}
.console-mark{width:24px;height:24px;border-radius:6px;background:var(--accent);color:#fff;display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:700;flex:none}
.console-wordmark{font-size:14px;font-weight:650;letter-spacing:.01em}
.console-nav-group{padding:12px 8px 0}
.console-nav-caption{padding:0 8px 6px;font-size:11px;color:var(--dim-light);letter-spacing:.06em}
.console-nav-link{position:relative;display:flex;align-items:center;width:100%;height:34px;padding:0 12px;border:0;border-radius:6px;background:transparent;color:var(--dim);font:inherit;font-size:13px;text-align:left;cursor:pointer;transition:background .15s,color .15s}
.console-nav-link:hover{background:var(--panel2);color:var(--fg)}
.console-nav-link.active{background:var(--accent-soft);color:var(--accent);font-weight:600}
.console-nav-link.active::after{content:"";position:absolute;left:0;top:7px;bottom:7px;width:2px;background:var(--accent);border-radius:0 2px 2px 0}
.console-sidebar-foot{display:flex;align-items:center;gap:6px;margin:auto 16px 14px;padding-top:12px;border-top:1px solid var(--line);color:var(--dim);font-size:11px}
.console-side-dot{width:6px;height:6px;border-radius:50%;background:var(--accent2);flex:none}
.console-side-dot.bad{background:var(--bad)}

.console-main{min-width:0;display:flex;flex-direction:column}
.console-contextbar{position:sticky;top:0;z-index:20;display:flex;align-items:center;gap:8px;height:52px;padding:0 var(--page-pad);background:var(--header-bg);border-bottom:1px solid var(--line);font-size:12px;color:var(--dim)}
.console-product{font-weight:600;color:var(--fg)}
.console-context-sep{width:1px;height:14px;background:var(--line)}
.console-context-actions{margin-left:auto;display:flex;align-items:center;gap:8px}
.wrap{width:100%;max-width:1320px;margin:0 auto;padding:18px var(--page-pad) 48px}

/* ---------- 页头 ---------- */
.pagehead{display:flex;align-items:flex-end;justify-content:space-between;gap:12px;margin:2px 0 14px}
.pagetitle{margin:0;font-size:19px;font-weight:650;letter-spacing:-.01em}
.pagesub{margin-left:8px;font-size:12px;font-weight:400;color:var(--dim-light)}

/* ---------- KPI ---------- */
.kpis{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px;margin-bottom:12px}
.kpi{position:relative;overflow:hidden;background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:14px 16px 13px;box-shadow:var(--shadow-sm)}
.kpi .accentbar{position:absolute;left:0;top:0;bottom:0;width:3px}
.kpi .k{display:flex;align-items:center;gap:5px;font-size:12px;color:var(--dim)}
.kpi .ic{font-size:10px;color:var(--accent)}
.kpi .v{margin-top:6px;font-size:26px;font-weight:650;line-height:1.15;font-variant-numeric:tabular-nums;letter-spacing:-.02em}
.kpi .s{margin-top:3px;font-size:11.5px;color:var(--dim-light)}

/* ---------- 卡片 ---------- */
.cards{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px;margin-bottom:12px}
.card{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:16px;box-shadow:var(--shadow-sm)}
.card .k{display:flex;align-items:center;gap:5px;font-size:13px;font-weight:600}
.card .k .ic{font-size:10px;color:var(--accent)}
.card .s{margin-top:2px;font-size:11.5px;color:var(--dim-light)}
.legend{display:flex;gap:12px;font-size:11.5px;color:var(--dim)}
.legend i{display:inline-block;width:8px;height:8px;border-radius:2px;margin-right:4px}

/* ---------- 表格 ---------- */
.table-wrap{overflow:auto}
table{width:100%;border-collapse:collapse;font-size:12.5px}
th{position:sticky;top:0;background:var(--panel);text-align:left;font-weight:600;font-size:11.5px;color:var(--dim);padding:9px 10px;border-bottom:1px solid var(--line);white-space:nowrap}
td{padding:9px 10px;border-bottom:1px solid var(--line);vertical-align:middle}
tbody tr:hover{background:var(--panel2)}
tbody tr:last-child td{border-bottom:0}

/* ---------- 控件 ---------- */
.btn{height:30px;padding:0 12px;border:1px solid var(--line);border-radius:6px;background:var(--panel);color:var(--fg);font:inherit;font-size:12.5px;cursor:pointer;display:inline-flex;align-items:center;gap:5px;transition:background .15s,border-color .15s;text-decoration:none}
.btn:hover{background:var(--panel2);border-color:var(--line-hover);text-decoration:none}
.pill{display:inline-flex;align-items:center;height:22px;padding:0 9px;border-radius:999px;background:var(--panel2);color:var(--dim);font-size:11.5px;white-space:nowrap}
.pill.ok{background:var(--accent2-soft);color:var(--accent2)}
.pill.bad{background:var(--bad-soft);color:var(--bad)}
.badge{display:inline-flex;align-items:center;height:20px;padding:0 7px;border-radius:5px;background:var(--panel2);color:var(--dim);font-size:11px;white-space:nowrap}
.badge.ok{background:var(--accent2-soft);color:var(--accent2)}
.badge.bad{background:var(--bad-soft);color:var(--bad)}
.seg{display:inline-flex;gap:2px;padding:2px;background:var(--panel2);border-radius:8px}
.seg button{height:26px;padding:0 11px;border:0;border-radius:6px;background:transparent;color:var(--dim);font:inherit;font-size:12px;cursor:pointer}
.seg button.on{background:var(--panel);color:var(--fg);font-weight:600;box-shadow:var(--shadow-sm)}
.empty{padding:26px 8px;text-align:center;color:var(--dim-light);font-size:12.5px;line-height:1.9}
.mono{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
.dim{color:var(--dim-light)}
.bad{color:var(--bad)}
.console-view-hidden{display:none!important}
.rowflex{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.spread{display:flex;align-items:center;justify-content:space-between;gap:12px}
.stack{display:grid;gap:11px}
.kv{display:flex;gap:6px;font-size:12px;color:var(--dim)}
.kv b{color:var(--fg);font-weight:600}

/* ---------- 图表与进度条 ---------- */
.bars{display:flex;align-items:flex-end;gap:2px;height:132px;margin-top:14px}
.bars .b{flex:1;display:flex;flex-direction:column;justify-content:flex-end;gap:1px;min-width:0}
.bars .b i{display:block;border-radius:2px 2px 0 0;background:var(--accent);opacity:.85;transition:height .45s cubic-bezier(.22,.61,.36,1)}
.bars .b i.e{background:var(--bad);opacity:.9}
.bars .b:hover i{opacity:1}
.xaxis{display:flex;justify-content:space-between;margin-top:7px;font-size:11px;color:var(--dim-light)}
.quota{height:6px;border-radius:99px;background:var(--panel3);overflow:hidden;margin-top:9px}
.quota>i{display:block;height:100%;border-radius:99px;background:var(--accent2);transition:width .5s}
.quota.mid>i{background:var(--warn)}
.quota.low>i{background:var(--bad)}
#toast{position:fixed;left:50%;bottom:28px;transform:translateX(-50%);background:var(--terminal-bg);color:var(--terminal-fg);padding:9px 16px;border-radius:8px;font-size:12.5px;z-index:99;box-shadow:var(--shadow-md)}

@media (max-width:1180px){
  .kpis{grid-template-columns:repeat(2,minmax(0,1fr))}
  .cards{grid-template-columns:1fr}
}
@media (max-width:760px){
  .console-shell{grid-template-columns:1fr}
  .console-sidebar{display:none}
  .wrap{padding:12px}
}
"""

out = shell.replace('/*__WB_CSS__*/', style).replace('/*__WB_CONSOLE_CSS__*/', '')
(ROOT / 'admin.html').write_text(out, encoding='utf-8')
print(f'admin.html {len(out.encode()):,} bytes | 样式 {len(style):,} 字符（WB 令牌 {len(tokens)}）')
