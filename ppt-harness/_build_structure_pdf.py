#!/usr/bin/env python3
# Render a Markdown file to a styled PDF via reportlab.
# Handles: #/##/### headings, paragraphs, - bullets, 1. numbered, ``` fenced code,
# pipe tables, inline `code` + **bold**, --- rules.
# Font: a full-Unicode CJK TTF (from a .ttc subfont) so box-drawing chars + CJK + ASCII
# all render (Courier lacks CJK; CID STSong-Light lacks box-drawing). Falls back gracefully.
import sys, re, html
from reportlab.lib.pagesizes import A4
from reportlab.lib.units import mm
from reportlab.lib import colors
from reportlab.platypus import (SimpleDocTemplate, Paragraph, Spacer, Preformatted,
                                Table, TableStyle, HRFlowable, KeepInFrame)
from reportlab.lib.styles import ParagraphStyle
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont

# ---- font registration: pick the first loadable full-Unicode CJK face ----
FONT = None
for path, idx in [('/System/Library/Fonts/Hiragino Sans GB.ttc', 0),
                  ('/System/Library/Fonts/PingFang.ttc', 0),
                  ('/System/Library/Fonts/STHeiti Medium.ttc', 0),
                  ('/System/Library/Fonts/Songti.ttc', 0)]:
    try:
        pdfmetrics.registerFont(TTFont('CJK', path, subfontIndex=idx))
        FONT = 'CJK'
        print('font: %s[%d]' % (path, idx))
        break
    except Exception:
        continue
if not FONT:
    from reportlab.pdfbase.cidfonts import UnicodeCIDFont
    pdfmetrics.registerFont(UnicodeCIDFont('STSong-Light'))
    FONT = 'STSong-Light'
    print('font: STSong-Light (CID fallback)')

INK    = colors.HexColor('#1f2328')
MUTED  = colors.HexColor('#57606a')
ACCENT = colors.HexColor('#0969da')
SUB    = colors.HexColor('#6e40c9')
CODEBG = colors.HexColor('#f6f8fa')
CODEBD = colors.HexColor('#d9dee3')
RULE   = colors.HexColor('#d0d7de')
TBG    = colors.HexColor('#0969da')
TALT   = colors.HexColor('#f6f8fa')
CODERED= colors.HexColor('#b14138')
CALLBG = colors.HexColor('#eef4ff')   # callout tint
CALLBAR = colors.HexColor('#0969da')  # callout left accent bar

USABLE = A4[0] - 2 * 16 * mm  # ~178mm

def make_styles():
    kw = dict(fontName=FONT)  # textColor set per-style to avoid kwarg collisions
    return {
        'h1': ParagraphStyle('h1', fontSize=20, leading=26, spaceBefore=6, spaceAfter=8, textColor=ACCENT, **kw),
        'h2': ParagraphStyle('h2', fontSize=14.5, leading=20, spaceBefore=14, spaceAfter=6, textColor=ACCENT, **kw),
        'h3': ParagraphStyle('h3', fontSize=12, leading=17, spaceBefore=10, spaceAfter=4, textColor=SUB, **kw),
        'body': ParagraphStyle('body', fontSize=10, leading=15.5, spaceAfter=6, textColor=INK, **kw),
        'li': ParagraphStyle('li', fontSize=10, leading=15, leftIndent=16, bulletIndent=4, spaceAfter=2, textColor=INK, **kw),
        'code': ParagraphStyle('code', fontName=FONT, fontSize=7.6, leading=9.8, textColor=INK,
                               backColor=CODEBG, borderColor=CODEBD, borderWidth=0.5, borderPadding=6,
                               spaceBefore=4, spaceAfter=8, leftIndent=0, rightIndent=0),
        'cell': ParagraphStyle('cell', fontName=FONT, fontSize=8.5, leading=11.5, textColor=INK),
        'cellh': ParagraphStyle('cellh', fontName=FONT, fontSize=8.7, leading=11.5, textColor=colors.white),
        'mute': ParagraphStyle('mute', fontName=FONT, fontSize=8.5, leading=12, textColor=MUTED, spaceAfter=8),
    }

def inline(s):
    s = html.escape(s)
    s = re.sub(r'\*\*(.+?)\*\*', r'<b>\1</b>', s)
    s = re.sub(r'`([^`]+)`', lambda m: '<font color="#b14138">%s</font>' % m.group(1), s)
    return s

def disp_width(text, fs=8.5):
    # rough width: CJK/fullwidth ~ fs each, ascii ~ fs*0.5
    w = 0.0
    for ch in text:
        w += fs if ord(ch) > 0x2E7F else fs * 0.52
    return w

def parse_table(lines, S):
    rows = [[c.strip() for c in ln.strip().strip('|').split('|')] for ln in lines]
    header = rows[0]
    body = [r for r in rows[2:] if any(c != '' for c in r)]  # skip separator row[1]
    ncol = len(header)
    # column width weights from max display width per column
    weights = []
    for ci in range(ncol):
        col = [header[ci]] + [r[ci] if ci < len(r) else '' for r in body]
        weights.append(max(disp_width(c) for c in col) + 6)
    tot = sum(weights)
    colw = [max(22 * mm, USABLE * w / tot) for w in weights]
    # normalize to usable width
    scale = USABLE / sum(colw)
    colw = [w * scale for w in colw]
    data = [[Paragraph(inline(h), S['cellh']) for h in header]]
    for r in body:
        data.append([Paragraph(inline(r[ci] if ci < len(r) else ''), S['cell']) for ci in range(ncol)])
    t = Table(data, colWidths=colw, repeatRows=1)
    style = [
        ('BACKGROUND', (0, 0), (-1, 0), TBG),
        ('GRID', (0, 0), (-1, -1), 0.4, RULE),
        ('VALIGN', (0, 0), (-1, -1), 'TOP'),
        ('LEFTPADDING', (0, 0), (-1, -1), 5),
        ('RIGHTPADDING', (0, 0), (-1, -1), 5),
        ('TOPPADDING', (0, 0), (-1, -1), 3.5),
        ('BOTTOMPADDING', (0, 0), (-1, -1), 3.5),
    ]
    for ri in range(2, len(data), 2):
        style.append(('BACKGROUND', (0, ri), (-1, ri), TALT))
    t.setStyle(TableStyle(style))
    return t

def callout(text, S):
    # Emphasis box: a 2-col table — thin accent bar + tinted content cell.
    style = ParagraphStyle('call', parent=S['body'], textColor=INK, fontSize=9.6, leading=14, spaceAfter=0)
    p = Paragraph(inline(text), style)
    t = Table([['', p]], colWidths=[2.8 * mm, USABLE - 2.8 * mm])
    t.setStyle(TableStyle([
        ('BACKGROUND', (0, 0), (0, 0), CALLBAR),
        ('BACKGROUND', (1, 0), (1, 0), CALLBG),
        ('VALIGN', (0, 0), (-1, -1), 'TOP'),
        ('LEFTPADDING', (0, 0), (0, 0), 0), ('RIGHTPADDING', (0, 0), (0, 0), 0),
        ('LEFTPADDING', (1, 0), (1, 0), 8), ('RIGHTPADDING', (1, 0), (1, 0), 8),
        ('TOPPADDING', (1, 0), (1, 0), 6), ('BOTTOMPADDING', (1, 0), (1, 0), 6),
    ]))
    return t

def md_to_flowables(md, S):
    out = []
    lines = md.split('\n')
    i = 0
    para_buf = []

    def flush_para():
        if para_buf:
            txt = ' '.join(l.strip() for l in para_buf).strip()
            if txt:
                out.append(Paragraph(inline(txt), S['body']))
            para_buf.clear()

    while i < len(lines):
        ln = lines[i]
        # fenced code
        if ln.strip().startswith('```'):
            flush_para()
            code = []
            i += 1
            while i < len(lines) and not lines[i].strip().startswith('```'):
                code.append(lines[i])
                i += 1
            i += 1  # skip closing fence
            out.append(Preformatted('\n'.join(code), S['code']))
            continue
        # horizontal rule
        if re.match(r'^-{3,}\s*$', ln.strip()):
            flush_para()
            out.append(Spacer(1, 2))
            out.append(HRFlowable(width='100%', thickness=0.6, color=RULE, spaceBefore=2, spaceAfter=6))
            i += 1
            continue
        # headings
        m = re.match(r'^(#{1,3})\s+(.*)$', ln)
        if m:
            flush_para()
            level = len(m.group(1))
            out.append(Paragraph(inline(m.group(2).strip()), S['h' + str(level)]))
            i += 1
            continue
        # table block
        if ln.strip().startswith('|'):
            flush_para()
            tbl = []
            while i < len(lines) and lines[i].strip().startswith('|'):
                tbl.append(lines[i]); i += 1
            out.append(parse_table(tbl, S))
            out.append(Spacer(1, 6))
            continue
        # bullet list
        if re.match(r'^\s*[-*]\s+', ln):
            flush_para()
            items = []
            while i < len(lines) and re.match(r'^\s*[-*]\s+', lines[i]):
                items.append(re.sub(r'^\s*[-*]\s+', '', lines[i]))
                i += 1
            for it in items:
                out.append(Paragraph(inline(it), S['li'], bulletText='•'))
            out.append(Spacer(1, 3))
            continue
        # numbered list
        if re.match(r'^\s*\d+\.\s+', ln):
            flush_para()
            items = []
            while i < len(lines) and re.match(r'^\s*\d+\.\s+', lines[i]):
                items.append(re.sub(r'^\s*\d+\.\s+', '', lines[i]))
                i += 1
            for n, it in enumerate(items, 1):
                out.append(Paragraph(inline(it), S['li'], bulletText='%d.' % n))
            out.append(Spacer(1, 3))
            continue
        # blockquote (> ...) -> emphasis callout box
        if ln.strip().startswith('>'):
            flush_para()
            q = []
            while i < len(lines) and lines[i].strip().startswith('>'):
                q.append(re.sub(r'^\s*>\s?', '', lines[i])); i += 1
            out.append(Spacer(1, 3))
            out.append(callout(' '.join(x.strip() for x in q), S))
            out.append(Spacer(1, 6))
            continue
        # blank line -> paragraph break
        if ln.strip() == '':
            flush_para()
            i += 1
            continue
        para_buf.append(ln)
        i += 1
    flush_para()
    return out

def build(md_path, pdf_path, title='ppt-harness 结构文档'):
    with open(md_path, encoding='utf-8') as f:
        md = f.read()
    S = make_styles()
    doc = SimpleDocTemplate(pdf_path, pagesize=A4,
                            leftMargin=16 * mm, rightMargin=16 * mm,
                            topMargin=16 * mm, bottomMargin=18 * mm,
                            title=title, author='ppt-harness')
    flow = md_to_flowables(md, S)

    def footer(canvas, d):
        canvas.saveState()
        canvas.setFont(FONT, 8)
        canvas.setFillColor(MUTED)
        canvas.drawString(16 * mm, 9 * mm, title)
        canvas.drawRightString(A4[0] - 16 * mm, 9 * mm, '%d' % d.page)
        canvas.setStrokeColor(RULE)
        canvas.setLineWidth(0.4)
        canvas.line(16 * mm, 12 * mm, A4[0] - 16 * mm, 12 * mm)
        canvas.restoreState()

    doc.build(flow, onFirstPage=footer, onLaterPages=footer)
    print('wrote', pdf_path)

if __name__ == '__main__':
    md = sys.argv[1] if len(sys.argv) > 1 else 'ppt-harness-结构文档.md'
    pdf = sys.argv[2] if len(sys.argv) > 2 else 'ppt-harness-结构文档.pdf'
    build(md, pdf)
