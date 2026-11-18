"""把 WB 面板的整套 CSS 注入到 panel_template.html，生成 panel.html"""
import os, re

ROOT = r"C:\Hermes\workspace\qwenwork2api"
CSS = r"C:\Users\jianh\AppData\Local\hermes\cache\browser-use\workspace\20261108_222713_7c0cabd6\wb_style.css"

css = open(CSS, encoding="utf-8", errors="replace").read()
tpl = open(os.path.join(ROOT, "panel_template.html"), encoding="utf-8").read()

# 去掉原作者品牌痕迹（只在 CSS 注释里出现，保险起见）
css = css.replace("WorkBuddy", "千问办公").replace("workbuddy", "qwenwork")

out = tpl.replace("/*__WB_CSS__*/", css)
path = os.path.join(ROOT, "panel.html")
open(path, "w", encoding="utf-8").write(out)
print(f"panel.html {len(out):,} 字节（CSS {len(css):,}）")

# 同时存一份主题 CSS 供仓库留存
open(os.path.join(ROOT, "panel_theme.css"), "w", encoding="utf-8").write(css)
print("panel_theme.css 已存")
