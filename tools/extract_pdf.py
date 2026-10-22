import sys, os
import pypdf

src = sys.argv[1]
out = sys.argv[2]

reader = pypdf.PdfReader(src)
lines = [f"PAGES={len(reader.pages)}"]
empty = []
for i, page in enumerate(reader.pages, 1):
    txt = page.extract_text() or ""
    if not txt.strip():
        empty.append(i)
    lines.append(f"\n===== PAGE {i} =====\n")
    lines.append(txt)

with open(out, "w", encoding="utf-8") as f:
    f.write("\n".join(lines))

print(f"OK pages={len(reader.pages)} bytes={os.path.getsize(out)} empty_pages={empty}")
