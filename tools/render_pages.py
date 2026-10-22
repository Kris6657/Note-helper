"""把课件 PDF 的指定页渲染成 PNG，用于读取「文字层为空」的页。

用法:
    python render_pages.py <课件.pdf> <页号> [<页号> ...] [--out <目录>] [--scale 2.2]
    python render_pages.py <课件.pdf> <页号> ... --montage [--cols 4]

两种模式:
    逐页模式（默认）  每页存一个 PNG，用于**读内容**。
    拼图模式 --montage 把所有页拼成一张 montage.png，用于**快速筛页**：
                      候选页多的时候先拼一张看一眼，只有标题的会自动露馅（分隔页、
                      装饰图），剩下的再从左上到右下按编号逐页放大读。
                      拼图的排列顺序会打印出来，按行从左到右数即可对上页号。

为什么需要它:
    extract_pdf.py 最后会打印 empty_pages=[...]，这些页在文字层里是空的，
    但它们**不一定**是空页——经常是一整页图版正文（图标 + 说明段，甚至整张表格），
    直接跳过就是真的丢内容。注意判不出的是哪种：「只有标题」的页里，
    有的只是分隔页，有的藏着一整张表，只能看图。

依赖:
    pypdfium2（渲染）；--montage 另需 Pillow。
    pip install -i https://pypi.tuna.tsinghua.edu.cn/simple pypdfium2 Pillow

输出:
    默认写到系统临时目录下的 pdfpageimg/。
"""
import argparse
import math
import os
import sys
import tempfile

INSTALL_HINT = "pip install -i https://pypi.tuna.tsinghua.edu.cn/simple pypdfium2 Pillow"


def main():
    ap = argparse.ArgumentParser(description="把 PDF 指定页渲染成 PNG")
    ap.add_argument("pdf", help="课件 PDF 的绝对路径")
    ap.add_argument("pages", nargs="+", type=int, help="要渲染的页号（1 起）")
    ap.add_argument("--out", default=None, help="输出目录，默认 %%TEMP%%/pdfpageimg")
    ap.add_argument("--scale", type=float, default=None,
                    help="缩放倍数；逐页模式默认 2.2，拼图模式默认 1.0")
    ap.add_argument("--montage", action="store_true",
                    help="拼成一张图（快速筛页用），不逐页输出")
    ap.add_argument("--cols", type=int, default=4, help="拼图列数，默认 4")
    a = ap.parse_args()

    try:
        import pypdfium2 as pdfium
    except ImportError:
        print("缺少 pypdfium2，请先安装：\n  " + INSTALL_HINT)
        return 1

    if not os.path.exists(a.pdf):
        print("找不到文件：%s" % a.pdf)
        return 1

    scale = a.scale if a.scale else (1.0 if a.montage else 2.2)
    outdir = a.out or os.path.join(tempfile.gettempdir(), "pdfpageimg")
    os.makedirs(outdir, exist_ok=True)

    doc = pdfium.PdfDocument(a.pdf)
    n = len(doc)
    valid = []
    for p in a.pages:
        if 1 <= p <= n:
            valid.append(p)
        else:
            print("  跳过 P%d（超出 1-%d）" % (p, n))
    if not valid:
        print("没有可渲染的页。")
        return 1

    print("PAGES=%d OUT=%s SCALE=%s MODE=%s" % (n, outdir, scale, "montage" if a.montage else "pages"))

    if a.montage:
        try:
            from PIL import Image
        except ImportError:
            print("拼图模式需要 Pillow，请先安装：\n  " + INSTALL_HINT)
            return 1
        tiles = [(p, doc[p - 1].render(scale=scale).to_pil().convert("RGB")) for p in valid]
        tw, th = tiles[0][1].size
        cols = max(1, a.cols)
        rows = math.ceil(len(tiles) / cols)
        sheet = Image.new("RGB", (tw * cols, th * rows), "white")
        for i, (_, im) in enumerate(tiles):
            r, c = divmod(i, cols)
            sheet.paste(im, (c * tw, r * th))
        fp = os.path.join(outdir, "montage.png")
        sheet.save(fp)
        print("  MONTAGE -> %s  (%dx%d, 每格 %dx%d)" % (fp, sheet.size[0], sheet.size[1], tw, th))
        print("  排列顺序（每行 %d 格，从上到下、从左到右）：" % cols)
        for r in range(rows):
            row = valid[r * cols:(r + 1) * cols]
            print("    第 %d 行: %s" % (r + 1, ", ".join("P%d" % p for p in row)))
        print("\n先看拼图筛掉纯分隔页；可疑的那几页再去掉 --montage 单独放大读。")
    else:
        for p in valid:
            img = doc[p - 1].render(scale=scale).to_pil()
            fp = os.path.join(outdir, "p%02d.png" % p)
            img.save(fp)
            print("  P%-4d -> %s  (%dx%d)" % (p, fp, img.size[0], img.size[1]))
        print("\n现在用图像方式读这些 PNG，按提示词第 15 条决定是否写进笔记。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
