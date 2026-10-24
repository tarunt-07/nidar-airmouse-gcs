"""Mission debrief PDF renderer.

Turns the JSON report that the dashboard POSTs to ``/api/report`` into a
printable A4 debrief: mission statistics, the survivor roster with grid cell
labels, and the final occupancy map when a PNG was supplied.

Everything is generated locally with reportlab - no network calls, which keeps
the GCS fully offline.
"""

from __future__ import annotations

import io
from datetime import datetime
from typing import Any, Optional

from reportlab.lib import colors
from reportlab.lib.enums import TA_LEFT
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import mm
from reportlab.platypus import Image, Paragraph, SimpleDocTemplate, Spacer, Table, TableStyle

INK = colors.HexColor("#0b1220")
SLATE = colors.HexColor("#475569")
RULE = colors.HexColor("#cbd5e1")
HEAD_BG = colors.HexColor("#f1f5f9")
ACCENT = colors.HexColor("#0284c7")
OK = colors.HexColor("#059669")

_PAGE_W, _PAGE_H = A4
_MARGIN = 18 * mm


def _styles() -> dict[str, ParagraphStyle]:
    base = getSampleStyleSheet()
    return {
        "title": ParagraphStyle(
            "DebriefTitle", parent=base["Normal"], fontName="Helvetica-Bold",
            fontSize=20, leading=24, textColor=INK, spaceAfter=2,
        ),
        "sub": ParagraphStyle(
            "DebriefSub", parent=base["Normal"], fontName="Helvetica-Bold",
            fontSize=9, leading=12, textColor=ACCENT, spaceAfter=10,
        ),
        "h2": ParagraphStyle(
            "DebriefH2", parent=base["Normal"], fontName="Helvetica-Bold",
            fontSize=11, leading=14, textColor=INK, spaceBefore=12, spaceAfter=6,
        ),
        "body": ParagraphStyle(
            "DebriefBody", parent=base["Normal"], fontName="Helvetica",
            fontSize=9, leading=13, textColor=SLATE, alignment=TA_LEFT,
        ),
        "cell": ParagraphStyle(
            "DebriefCell", parent=base["Normal"], fontName="Helvetica",
            fontSize=8.5, leading=11, textColor=INK,
        ),
        "cellhead": ParagraphStyle(
            "DebriefCellHead", parent=base["Normal"], fontName="Helvetica-Bold",
            fontSize=8.5, leading=11, textColor=INK,
        ),
    }


def _fmt_duration(seconds: Any) -> str:
    try:
        total = int(max(0.0, float(seconds)))
    except (TypeError, ValueError):
        return "-"
    return f"{total // 60:02d}:{total % 60:02d}"


def _fmt(value: Any, suffix: str = "", digits: int = 1) -> str:
    if value is None:
        return "-"
    if isinstance(value, (int, float)):
        return f"{value:.{digits}f}{suffix}"
    return str(value)


def _meta_table(report: dict[str, Any], st: dict[str, ParagraphStyle]) -> Table:
    state = str(report.get("state", "-")).upper()
    rows = [
        ("MISSION RESULT", state, "TOTAL TIME", _fmt_duration(report.get("elapsed_s"))),
        ("AREA EXPLORED", _fmt(report.get("explored_pct"), "%", 0), "DISTANCE FLOWN",
         _fmt(report.get("distance_m"), " m")),
        ("SURVIVORS FOUND", f"{len(report.get('survivors') or [])} / 6", "BATTERY REMAINING",
         _fmt(report.get("battery_pct"), "%")),
        ("FINISHED", str(report.get("finished_at", "-"))[:19].replace("T", " "), "GENERATED",
         datetime.now().strftime("%Y-%m-%d %H:%M")),
    ]
    data = []
    for k1, v1, k2, v2 in rows:
        data.append([
            Paragraph(k1, st["cellhead"]), Paragraph(str(v1), st["cell"]),
            Paragraph(k2, st["cellhead"]), Paragraph(str(v2), st["cell"]),
        ])
    table = Table(data, colWidths=[95, 110, 105, 95])
    table.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, -1), HEAD_BG),
        ("BOX", (0, 0), (-1, -1), 0.75, RULE),
        ("INNERGRID", (0, 0), (-1, -1), 0.5, colors.HexColor("#e2e8f0")),
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        ("TOPPADDING", (0, 0), (-1, -1), 6),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 6),
        ("LEFTPADDING", (0, 0), (-1, -1), 7),
        ("RIGHTPADDING", (0, 0), (-1, -1), 7),
    ]))
    return table


def _survivor_table(report: dict[str, Any], st: dict[str, ParagraphStyle]) -> Table:
    survivors = report.get("survivors") or []
    data = [[
        Paragraph("#", st["cellhead"]),
        Paragraph("CELL", st["cellhead"]),
        Paragraph("X (m)", st["cellhead"]),
        Paragraph("Y (m)", st["cellhead"]),
        Paragraph("CONFIDENCE", st["cellhead"]),
    ]]
    for s in survivors:
        conf = s.get("conf")
        data.append([
            Paragraph(f"S{s.get('id', '-')}", st["cell"]),
            Paragraph(str(s.get("cell", "-")), st["cell"]),
            Paragraph(_fmt(s.get("x"), digits=2), st["cell"]),
            Paragraph(_fmt(s.get("y"), digits=2), st["cell"]),
            Paragraph(_fmt(conf * 100 if isinstance(conf, (int, float)) else None, "%", 0),
                      st["cell"]),
        ])
    if len(data) == 1:
        data.append([Paragraph("none detected", st["cell"]), "", "", "", ""])
    table = Table(data, colWidths=[45, 95, 90, 90, 95])
    table.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, 0), HEAD_BG),
        ("BOX", (0, 0), (-1, -1), 0.75, RULE),
        ("INNERGRID", (0, 0), (-1, -1), 0.5, colors.HexColor("#e2e8f0")),
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        ("TOPPADDING", (0, 0), (-1, -1), 5),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 5),
        ("LEFTPADDING", (0, 0), (-1, -1), 7),
        ("RIGHTPADDING", (0, 0), (-1, -1), 7),
    ]))
    return table


def _footer(canvas, doc) -> None:  # noqa: ANN001 - reportlab callback
    canvas.saveState()
    canvas.setStrokeColor(RULE)
    canvas.setLineWidth(0.75)
    canvas.line(_MARGIN, 14 * mm, _PAGE_W - _MARGIN, 14 * mm)
    canvas.setFont("Helvetica", 7.5)
    canvas.setFillColor(SLATE)
    canvas.drawString(_MARGIN, 10 * mm, "NIDAR AirMouse GCS - mission debrief")
    canvas.drawRightString(_PAGE_W - _MARGIN, 10 * mm, f"page {doc.page}")
    canvas.restoreState()


def build_debrief_pdf(report: dict[str, Any], png: Optional[bytes]) -> bytes:
    """Render the debrief and return the PDF as bytes."""
    st = _styles()
    buf = io.BytesIO()
    doc = SimpleDocTemplate(
        buf, pagesize=A4,
        leftMargin=_MARGIN, rightMargin=_MARGIN,
        topMargin=_MARGIN, bottomMargin=20 * mm,
        title="NIDAR AirMouse GCS - Mission Debrief",
        author="NIDAR AirMouse GCS",
    )

    state = str(report.get("state", "-")).upper()
    story: list[Any] = [
        Paragraph("NIDAR AirMouse Ground Control Station", st["title"]),
        Paragraph(f"MISSION DEBRIEF · {state}", st["sub"]),
        _meta_table(report, st),
        Paragraph("Survivor roster", st["h2"]),
        _survivor_table(report, st),
    ]

    if png:
        try:
            # Scale the final map to the printable width, keeping aspect ratio.
            from PIL import Image as PILImage  # noqa: PLC0415 - optional path

            with PILImage.open(io.BytesIO(png)) as im:
                width_px, height_px = im.size
            max_w = _PAGE_W - 2 * _MARGIN
            max_h = 150 * mm
            scale = min(max_w / max(width_px, 1), max_h / max(height_px, 1))
            story.append(Paragraph("Final occupancy map", st["h2"]))
            story.append(Image(io.BytesIO(png), width=width_px * scale, height=height_px * scale))
        except Exception:  # pragma: no cover - a broken PNG must not break the report
            story.append(Paragraph("Final occupancy map: unavailable", st["body"]))

    story.append(Spacer(1, 10))
    story.append(Paragraph(
        "Generated offline by the GCS debrief. No data left this machine.",
        st["body"],
    ))

    doc.build(story, onFirstPage=_footer, onLaterPages=_footer)
    return buf.getvalue()
