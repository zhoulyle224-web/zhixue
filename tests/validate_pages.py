from html.parser import HTMLParser
from pathlib import Path
import re

root = Path(__file__).parents[1] / "github-pages"
for name in ("index.html", "login.html", "student.html", "teacher.html", "404.html"):
    text = (root / name).read_text(encoding="utf-8")
    HTMLParser().feed(text)
    assert "比赛" not in text
    assert "学校名称" not in text
    for target in re.findall(r'href="([^"#]+)', text):
        if target.startswith(("http:", "https:", "mailto:")):
            continue
        file_target = target.split("?", 1)[0]
        assert (root / file_target).exists(), f"broken link in {name}: {target}"

home = (root / "index.html").read_text(encoding="utf-8")
assert 'href="login.html?role=student"' in home
assert 'href="login.html?role=teacher"' in home
login = (root / "login.html").read_text(encoding="utf-8")
assert 'id="loginForm"' in login
assert 'data-login-role="teacher"' in login
assert 'data-login-role="student"' in login
print("MULTI_PAGE_SITE_OK")
