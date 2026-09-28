#!/usr/bin/env python3
"""Append ?v=<content hash> to every local css/js link in the HTML pages.

GitHub Pages lets browsers cache files for ~10 minutes, so after a deploy players could keep running
old CSS/JS. A content hash changes only when the file changes, forcing a fresh download exactly then.
Run before committing:  python3 tools/bump_versions.py
"""
import hashlib, pathlib, re

root = pathlib.Path(__file__).resolve().parent.parent
pattern = re.compile(r'(href|src)="((?:css|js)/[^"?]+)(?:\?v=[^"]*)?"')

for page in root.glob('*.html'):
    html = page.read_text(encoding='utf-8')
    def repl(m):
        digest = hashlib.sha1((root / m.group(2)).read_bytes()).hexdigest()[:8]
        return f'{m.group(1)}="{m.group(2)}?v={digest}"'
    new = pattern.sub(repl, html)
    if new != html:
        page.write_text(new, encoding='utf-8')
        print('updated', page.name)
