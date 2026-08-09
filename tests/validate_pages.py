from html.parser import HTMLParser
from pathlib import Path
import re

root = Path(__file__).parents[1] / "github-pages"
for name in ("index.html", "student.html", "teacher.html", "404.html"):
    text = (root / name).read_text(encoding="utf-8")
    HTMLParser().feed(text)
    assert "比赛" not in text
    assert "学校名称" not in text
    for target in re.findall(r'href="([^"#]+)', text):
        if target.startswith(("http:", "https:", "mailto:")):
            continue
        assert (root / target).exists(), f"broken link in {name}: {target}"

assert 'href="student.html"' in (root / "index.html").read_text(encoding="utf-8")
assert 'href="teacher.html"' in (root / "index.html").read_text(encoding="utf-8")
print("MULTI_PAGE_SITE_OK")
