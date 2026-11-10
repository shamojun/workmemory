"""把 WorkMemory 完整设计文档（Markdown）转成排版良好的 Word 文档。

用法：
  python scripts/build_docx.py <input.md> <output.docx>
"""
import re
import sys

from docx import Document
from docx.enum.section import WD_SECTION
from docx.enum.table import WD_TABLE_ALIGNMENT
from docx.enum.text import WD_ALIGN_PARAGRAPH
from docx.oxml.ns import qn
from docx.shared import Cm, Pt, RGBColor

BODY_FONT = "微软雅黑"
CODE_FONT = "Consolas"
MONO_COLOR = RGBColor(0x33, 0x33, 0x33)
ACCENT = RGBColor(0x1F, 0x4E, 0x79)


def set_font(run, name, size=None, bold=None, color=None):
    run.font.name = name
    rpr = run._element.get_or_add_rPr()
    rfonts = rpr.find(qn("w:rFonts"))
    if rfonts is None:
        rfonts = rpr.makeelement(qn("w:rFonts"), {})
        rpr.append(rfonts)
    rfonts.set(qn("w:ascii"), name)
    rfonts.set(qn("w:hAnsi"), name)
    rfonts.set(qn("w:eastAsia"), name)
    if size is not None:
        run.font.size = Pt(size)
    if bold is not None:
        run.font.bold = bold
    if color is not None:
        run.font.color.rgb = color


def add_runs(paragraph, text, size=10.5, base_bold=False, mono=False):
    """处理 **加粗**、`行内代码` 与 [文字](链接)（只保留文字）。"""
    text = re.sub(r"\[([^\]]+)\]\([^)]*\)", r"\1", text)
    tokens = re.split(r"(\*\*[^*]+\*\*|`[^`]+`)", text)
    for token in tokens:
        if not token:
            continue
        if token.startswith("**") and token.endswith("**"):
            run = paragraph.add_run(token[2:-2])
            set_font(run, BODY_FONT, size, bold=True)
        elif token.startswith("`") and token.endswith("`"):
            run = paragraph.add_run(token[1:-1])
            set_font(run, CODE_FONT, size - 0.5, bold=base_bold, color=MONO_COLOR)
        else:
            run = paragraph.add_run(token)
            set_font(run, BODY_FONT, size, bold=base_bold)


def shade(paragraph, hex_fill="F5F5F5"):
    ppr = paragraph._p.get_or_add_pPr()
    shd = ppr.makeelement(qn("w:shd"), {qn("w:val"): "clear", qn("w:color"): "auto", qn("w:fill"): hex_fill})
    ppr.append(shd)


def parse_table_row(line):
    cells = [c.strip() for c in line.strip().strip("|").split("|")]
    return cells


def is_separator(line):
    return bool(re.fullmatch(r"\|?[\s:|-]+\|?", line.strip())) and "-" in line


def build(md_path, out_path):
    with open(md_path, "r", encoding="utf-8") as fh:
        lines = fh.read().split("\n")

    doc = Document()

    style = doc.styles["Normal"]
    style.font.name = BODY_FONT
    style.font.size = Pt(10.5)
    style.element.rPr.rFonts.set(qn("w:eastAsia"), BODY_FONT)

    for section in doc.sections:
        section.page_width = Cm(21)
        section.page_height = Cm(29.7)
        section.left_margin = Cm(2.2)
        section.right_margin = Cm(2.2)
        section.top_margin = Cm(2.0)
        section.bottom_margin = Cm(2.0)

    i = 0
    total = len(lines)
    first_h1_done = False
    prev_was_ordered = False
    ordered_counter = 0

    while i < total:
        line = lines[i]
        stripped = line.strip()

        # 代码块
        if stripped.startswith("```"):
            i += 1
            block = []
            while i < total and not lines[i].strip().startswith("```"):
                block.append(lines[i])
                i += 1
            i += 1
            for code_line in block:
                para = doc.add_paragraph()
                para.paragraph_format.space_before = Pt(0)
                para.paragraph_format.space_after = Pt(0)
                para.paragraph_format.left_indent = Cm(0.5)
                run = para.add_run(code_line if code_line else " ")
                set_font(run, CODE_FONT, 9)
                shade(para)
            doc.add_paragraph().paragraph_format.space_after = Pt(2)
            continue

        # 表格
        if stripped.startswith("|") and i + 1 < total and is_separator(lines[i + 1]):
            header = parse_table_row(lines[i])
            i += 2
            rows = []
            while i < total and lines[i].strip().startswith("|"):
                rows.append(parse_table_row(lines[i]))
                i += 1
            table = doc.add_table(rows=1, cols=len(header))
            table.style = "Table Grid"
            table.alignment = WD_TABLE_ALIGNMENT.CENTER
            for idx, text in enumerate(header):
                cell = table.rows[0].cells[idx]
                cell.text = ""
                para = cell.paragraphs[0]
                add_runs(para, text, size=9.5, base_bold=True)
            for row in rows:
                cells = table.add_row().cells
                for idx, text in enumerate(row[: len(header)]):
                    cells[idx].text = ""
                    add_runs(cells[idx].paragraphs[0], text, size=9.5)
            doc.add_paragraph().paragraph_format.space_after = Pt(2)
            continue

        # 标题
        if stripped.startswith("#"):
            level = len(stripped) - len(stripped.lstrip("#"))
            text = stripped[level:].strip()
            if level == 1 and not first_h1_done:
                para = doc.add_paragraph()
                para.alignment = WD_ALIGN_PARAGRAPH.CENTER
                para.paragraph_format.space_after = Pt(6)
                run = para.add_run(text)
                set_font(run, BODY_FONT, 22, bold=True, color=ACCENT)
                first_h1_done = True
            else:
                heading = doc.add_heading(level=min(level - 1, 3))
                heading.text = ""
                # 标题里的 `code` 标记去掉反引号，按普通文字渲染
                run = heading.add_run(text.replace("`", ""))
                size = {2: 16, 3: 13.5, 4: 12}.get(level, 11.5)
                set_font(run, BODY_FONT, size, bold=True, color=ACCENT)
            i += 1
            continue

        # 分隔线
        if stripped == "---":
            para = doc.add_paragraph()
            para.paragraph_format.space_before = Pt(2)
            para.paragraph_format.space_after = Pt(2)
            run = para.add_run("─" * 40)
            set_font(run, BODY_FONT, 8, color=RGBColor(0xBB, 0xBB, 0xBB))
            i += 1
            continue

        # 引用
        if stripped.startswith(">"):
            text = stripped.lstrip("> ").strip()
            para = doc.add_paragraph()
            para.paragraph_format.left_indent = Cm(0.8)
            add_runs(para, text, size=10)
            for run in para.runs:
                run.font.italic = True
                run.font.color.rgb = RGBColor(0x55, 0x55, 0x55)
            i += 1
            continue

        # 无序列表
        if re.match(r"^[-*]\s+", stripped):
            text = re.sub(r"^[-*]\s+", "", stripped)
            para = doc.add_paragraph(style="List Bullet")
            para.paragraph_format.space_after = Pt(2)
            add_runs(para, text)
            i += 1
            continue

        # 有序列表（手写序号，避免 Word 自动编号跨列表续号）
        if re.match(r"^\d+\.\s+", stripped):
            if prev_was_ordered:
                ordered_counter += 1
            else:
                ordered_counter = int(re.match(r"^(\d+)\.", stripped).group(1))
            text = re.sub(r"^\d+\.\s+", "", stripped)
            para = doc.add_paragraph()
            para.paragraph_format.left_indent = Cm(0.8)
            para.paragraph_format.space_after = Pt(2)
            add_runs(para, f"{ordered_counter}. {text}")
            prev_was_ordered = True
            i += 1
            continue
        prev_was_ordered = False

        # 空行
        if not stripped:
            i += 1
            continue

        # 正文
        para = doc.add_paragraph()
        para.paragraph_format.space_after = Pt(4)
        para.paragraph_format.line_spacing = 1.25
        add_runs(para, stripped)
        i += 1

    doc.save(out_path)

    check = Document(out_path)
    return {
        "out": out_path,
        "paragraphs": len(check.paragraphs),
        "tables": len(check.tables),
        "headings": sum(1 for p in check.paragraphs if p.style.name.startswith("Heading")),
    }


if __name__ == "__main__":
    src = sys.argv[1]
    dst = sys.argv[2]
    print(build(src, dst))
