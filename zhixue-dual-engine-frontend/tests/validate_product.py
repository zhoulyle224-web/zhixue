from html.parser import HTMLParser
from pathlib import Path

source = Path(__file__).parents[1] / "智学双擎_产品版.html"
html = source.read_text(encoding="utf-8")
HTMLParser().feed(html)

assert "比赛" not in html
assert "演示原型" not in html
assert "localStorage" in html
assert html.count('class="view') >= 7
assert "og.png" in html
print("PRODUCT_HTML_OK", len(html))
