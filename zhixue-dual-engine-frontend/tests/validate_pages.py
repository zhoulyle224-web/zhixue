from html.parser import HTMLParser
from pathlib import Path
import json
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

teacher = (root / "teacher.html").read_text(encoding="utf-8")
student = (root / "student.html").read_text(encoding="utf-8")
app_js = (root / "assets" / "app.js").read_text(encoding="utf-8")
snapshot = json.loads((root / "assets" / "demo-data.json").read_text(encoding="utf-8"))
worker = (root.parent / "worker" / "index.js").read_text(encoding="utf-8")
hosting = json.loads((root.parent / ".openai" / "hosting.json").read_text(encoding="utf-8"))

assert 'id="databaseStatus"' in teacher
assert 'id="databaseStatus"' in student
assert "/api/catalog" in app_js and "/api/dashboard" in app_js
assert "env.DB.prepare" in worker
assert hosting["d1"] == "DB"
assert snapshot["meta"]["studentCount"] == 180
assert snapshot["meta"]["tableCount"] >= 30
assert len(snapshot["teacher"]) >= 30
assert "student:S240101" in snapshot["student"]
print("MULTI_PAGE_SITE_OK")
