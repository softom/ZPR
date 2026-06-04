#!/usr/bin/env python
"""
scripts/import_kpt_geometry.py

Импорт кадастровых участков из XML-файла КПТ (Кадастровый План Территории):
  - Геометрия (MultiPolygon, EPSG:4326 через ST_Transform из СК-63)
  - Метаданные: адрес, ВРИ, категория, площадь, стоимость, погрешность и т.д.
  - Новые участки (не из нашей БД) создаются с in_project=false, source='kpt_xml'
  - Существующие участки дополняются метаданными и геометрией

Координаты в КПТ приходят в СК-63 (зона 4, SRID 970634).
Конвертация в WGS84 (4326) выполняется через PostGIS ST_Transform.

Использование:
  python scripts/import_kpt_geometry.py "C:\\path\\to\\kpt11.xml.zip"
  python scripts/import_kpt_geometry.py "C:\\path\\to\\kpt11.xml"
  python scripts/import_kpt_geometry.py "C:\\path\\to\\kpt11.xml.zip" --dry-run
  python scripts/import_kpt_geometry.py "C:\\path\\to\\kpt11.xml.zip" --verbose

Формат КПТ v11 (extract_cadastral_plan_territory):
  land_record → object/common_data/cad_number
              → params/area/value, params/area/inaccuracy
              → params/category/type/code
              → params/permitted_use/.../by_document
              → cost/value
              → object/subtype/code
              → address_location/address/readable_address
              → entity_spatial / contours_location → spatial_element → ordinates
"""
from __future__ import annotations

import argparse
import json
import logging
import re
import sys
import xml.etree.ElementTree as ET
import zipfile
from pathlib import Path

# Корень репо → import config
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import config  # type: ignore  # noqa: E402

import psycopg2  # noqa: E402

# ── Логирование ──────────────────────────────────────────────────────────────

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s  %(levelname)-7s  %(message)s",
    datefmt="%H:%M:%S",
)
log = logging.getLogger("import_kpt")

# Маппинг sk_id из КПТ → PostGIS SRID
SK_ID_MAP: dict[str, int] = {
    "90.4":       970634,
    "63.4":       970634,
    # Кириллические варианты (UTF-8)
    "СК-63, зона 4": 970634,
    "СК 63":      970634,
    "СК-63":      970634,
}
DEFAULT_SRID = 970634  # СК-63 зона 4 — основная для Крыма


# ── Утилиты ─────────────────────────────────────────────────────────────────

def _text(el: ET.Element | None) -> str | None:
    """Безопасно извлекает текст из элемента."""
    if el is not None and el.text:
        return el.text.strip()
    return None


def _float(el: ET.Element | None) -> float | None:
    """Безопасно извлекает число из элемента."""
    t = _text(el)
    if t:
        try:
            return float(t)
        except ValueError:
            return None
    return None


def cad_quarter_from_number(cad_number: str) -> str | None:
    """Извлекает кадастровый квартал из номера: 90:18:010182:2 → 90:18:010182"""
    m = re.match(r'^(\d+:\d+:\d+):', cad_number)
    return m.group(1) if m else None


# ── Парсинг КПТ XML ─────────────────────────────────────────────────────────

def read_xml(filepath: str) -> ET.Element:
    """Читает XML из .xml или .xml.zip файла."""
    p = Path(filepath)
    if p.suffix == '.zip' or filepath.endswith('.xml.zip'):
        with zipfile.ZipFile(filepath) as z:
            xml_names = [n for n in z.namelist() if n.endswith('.xml')]
            if not xml_names:
                raise ValueError(f"В ZIP нет XML-файлов: {z.namelist()}")
            data = z.read(xml_names[0])
            return ET.fromstring(data)
    else:
        return ET.parse(filepath).getroot()


def parse_land_records(root: ET.Element) -> list[dict]:
    """
    Извлекает ВСЕ данные кадастровых участков из КПТ.

    Возвращает список словарей:
    {
        cad_number, address, category, vri, area_m2,
        cadastral_cost, area_inaccuracy, category_code, subtype_code, cad_quarter,
        srid, rings: [[(x,y), ...], ...] | None   (None = нет геометрии)
    }
    """
    results = []

    for rec in root.findall('.//land_record'):
        cn_el = rec.find('.//cad_number')
        if cn_el is None or not cn_el.text:
            continue
        cad_number = cn_el.text.strip()

        # ── Метаданные ──
        address = _text(rec.find('.//readable_address'))
        category = _text(rec.find('.//category/type/value'))
        category_code = _text(rec.find('.//category/type/code'))
        vri = _text(rec.find('.//permitted_use_established/by_document'))
        area_m2 = _float(rec.find('.//area/value'))
        area_inaccuracy = _float(rec.find('.//area/inaccuracy'))
        cadastral_cost = _float(rec.find('.//cost/value'))
        subtype_code = _text(rec.find('.//subtype/code'))
        cad_quarter = cad_quarter_from_number(cad_number)

        # ── Геометрия ──
        # КПТ может хранить координаты двумя способами:
        # 1) contours_location/contours/contour/entity_spatial (многоконтурные)
        # 2) entity_spatial напрямую (одноконтурные)
        spatials = rec.findall('.//entity_spatial')
        srid = DEFAULT_SRID
        all_rings: list[list[tuple[float, float]]] = []

        for spatial in spatials:
            # Определяем SRID
            sk_el = spatial.find('sk_id')
            sk_text = _text(sk_el)
            if sk_text:
                srid = SK_ID_MAP.get(sk_text, DEFAULT_SRID)

            for sp_elem in spatial.findall('.//spatial_element'):
                coords: list[tuple[float, float]] = []
                for ordinate in sp_elem.findall('.//ordinate'):
                    x_el = ordinate.find('x')
                    y_el = ordinate.find('y')
                    if x_el is not None and y_el is not None and x_el.text and y_el.text:
                        x = float(x_el.text)
                        y = float(y_el.text)
                        coords.append((x, y))

                if len(coords) >= 3:
                    # Замыкаем кольцо если не замкнуто
                    if coords[0] != coords[-1]:
                        coords.append(coords[0])
                    all_rings.append(coords)

        record = {
            "cad_number": cad_number,
            "address": address,
            "category": category,
            "vri": vri,
            "area_m2": area_m2,
            "cadastral_cost": cadastral_cost,
            "area_inaccuracy": area_inaccuracy,
            "category_code": category_code,
            "subtype_code": subtype_code,
            "cad_quarter": cad_quarter,
            "srid": srid,
            "rings": all_rings if all_rings else None,
        }
        results.append(record)

    return results


# ── Конвертация и запись в БД ────────────────────────────────────────────────

def build_polygon_wkt(rings: list[list[tuple[float, float]]]) -> str:
    """Строит WKT POLYGON из колец. Первое кольцо — внешнее, остальные — дырки."""
    ring_strs = []
    for ring in rings:
        pts = ", ".join(f"{y} {x}" for x, y in ring)  # WKT: X=easting(y), Y=northing(x)
        ring_strs.append(f"({pts})")
    return f"POLYGON({', '.join(ring_strs)})"


def import_to_db(
    conn,
    records: list[dict],
    *,
    dry_run: bool = False,
) -> dict:
    """
    Для каждого КН из КПТ:
    1. Проверяем, есть ли в cadastrals
    2. Если есть — обновляем метаданные + геометрию
    3. Если нет — создаём запись с source='kpt_xml', in_project=false

    Возвращает статистику.
    """
    cur = conn.cursor()
    stats = {"total": len(records), "updated": 0, "created": 0, "geom_set": 0, "errors": 0}

    for rec in records:
        kn = rec["cad_number"]

        # Проверяем наличие в БД
        cur.execute(
            "SELECT id, source FROM cadastrals WHERE cadastral_number = %s",
            (kn,),
        )
        row = cur.fetchone()

        if row:
            # ── ОБНОВЛЕНИЕ существующей записи ──
            cad_id = row[0]
            existing_source = row[1]
            log.info("  %s — обновляю (id=%s)", kn, cad_id)

            # Обновляем метаданные
            meta_updates = []
            meta_values = []

            # Поля из ПМТ: заполняем только если в БД пусто (COALESCE)
            coalesce_fields = {
                "address": rec["address"],
                "category": rec["category"],
                "vri": rec["vri"],
                "area_m2": rec["area_m2"],
            }
            for col, val in coalesce_fields.items():
                if val is not None:
                    meta_updates.append(f"{col} = COALESCE({col}, %s)")
                    meta_values.append(val)

            # Новые поля из XML: всегда перезаписываем актуальными данными
            overwrite_fields = {
                "cadastral_cost": rec["cadastral_cost"],
                "area_inaccuracy": rec["area_inaccuracy"],
                "category_code": rec["category_code"],
                "subtype_code": rec["subtype_code"],
                "cad_quarter": rec["cad_quarter"],
            }
            for col, val in overwrite_fields.items():
                if val is not None:
                    meta_updates.append(f"{col} = %s")
                    meta_values.append(val)

            if meta_updates:
                meta_updates.append("updated_at = now()")
                sql = f"UPDATE cadastrals SET {', '.join(meta_updates)} WHERE id = %s"
                meta_values.append(cad_id)
                if not dry_run:
                    try:
                        cur.execute(sql, meta_values)
                    except Exception as e:
                        log.error("    ошибка обновления метаданных: %s", e)
                        conn.rollback()
                        stats["errors"] += 1
                        continue

            # Обновляем геометрию
            if rec["rings"]:
                wkt = build_polygon_wkt(rec["rings"])
                srid = rec["srid"]
                log.info("    геометрия: %d кольц(о/а), SRID=%d", len(rec["rings"]), srid)
                if not dry_run:
                    try:
                        cur.execute(
                            """
                            UPDATE cadastrals
                            SET geom = ST_Multi(ST_Transform(ST_GeomFromText(%s, %s), 4326)),
                                updated_at = now()
                            WHERE id = %s
                            """,
                            (wkt, srid, cad_id),
                        )
                        stats["geom_set"] += 1
                    except Exception as e:
                        log.error("    ошибка записи геометрии: %s", e)
                        conn.rollback()
                        stats["errors"] += 1
                        continue
                else:
                    stats["geom_set"] += 1

            stats["updated"] += 1

        else:
            # ── СОЗДАНИЕ новой записи ──
            log.info("  %s — НОВЫЙ (не в проекте), создаю", kn)

            if dry_run:
                stats["created"] += 1
                if rec["rings"]:
                    stats["geom_set"] += 1
                continue

            try:
                if rec["rings"]:
                    wkt = build_polygon_wkt(rec["rings"])
                    srid = rec["srid"]
                    cur.execute(
                        """
                        INSERT INTO cadastrals (
                            cadastral_number, address, category, vri, area_m2,
                            cadastral_cost, area_inaccuracy, category_code,
                            subtype_code, cad_quarter,
                            source, in_project, active,
                            geom
                        ) VALUES (
                            %s, %s, %s, %s, %s,
                            %s, %s, %s,
                            %s, %s,
                            'kpt_xml', false, true,
                            ST_Multi(ST_Transform(ST_GeomFromText(%s, %s), 4326))
                        )
                        """,
                        (
                            kn, rec["address"], rec["category"], rec["vri"], rec["area_m2"],
                            rec["cadastral_cost"], rec["area_inaccuracy"], rec["category_code"],
                            rec["subtype_code"], rec["cad_quarter"],
                            wkt, srid,
                        ),
                    )
                    stats["geom_set"] += 1
                else:
                    cur.execute(
                        """
                        INSERT INTO cadastrals (
                            cadastral_number, address, category, vri, area_m2,
                            cadastral_cost, area_inaccuracy, category_code,
                            subtype_code, cad_quarter,
                            source, in_project, active
                        ) VALUES (
                            %s, %s, %s, %s, %s,
                            %s, %s, %s,
                            %s, %s,
                            'kpt_xml', false, true
                        )
                        """,
                        (
                            kn, rec["address"], rec["category"], rec["vri"], rec["area_m2"],
                            rec["cadastral_cost"], rec["area_inaccuracy"], rec["category_code"],
                            rec["subtype_code"], rec["cad_quarter"],
                        ),
                    )
                stats["created"] += 1
            except Exception as e:
                log.error("    ошибка создания: %s", e)
                conn.rollback()
                stats["errors"] += 1

    if not dry_run:
        conn.commit()

    cur.close()
    return stats


# ── Main ─────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(
        description="Импорт кадастровых участков из КПТ XML (геометрия + метаданные)"
    )
    parser.add_argument(
        "file",
        help="Путь к КПТ XML файлу (.xml или .xml.zip)",
    )
    parser.add_argument(
        "--dry-run", action="store_true",
        help="Не записывать в БД, только показать что будет сделано",
    )
    parser.add_argument(
        "--verbose", action="store_true",
        help="Подробный лог",
    )
    args = parser.parse_args()

    if args.verbose:
        log.setLevel(logging.DEBUG)

    # Парсинг XML
    log.info("Чтение %s ...", args.file)
    root = read_xml(args.file)
    records = parse_land_records(root)
    log.info("Найдено %d участков в КПТ", len(records))

    with_geom = sum(1 for r in records if r["rings"])
    without_geom = len(records) - with_geom
    log.info("  с геометрией: %d, без геометрии: %d", with_geom, without_geom)

    if not records:
        log.info("Нет данных для импорта")
        return

    # Показать найденные КН
    for rec in records:
        geom_info = f"{len(rec['rings'])} кольц, SRID={rec['srid']}" if rec["rings"] else "без геом."
        log.info("  %s — %s, площадь=%s м², стоимость=%s",
                 rec["cad_number"], geom_info,
                 rec["area_m2"] or "?", rec["cadastral_cost"] or "?")

    # Подключение к БД
    log.info("Подключение к БД: %s", config.SUPABASE_DB_URL)
    conn = psycopg2.connect(config.SUPABASE_DB_URL)

    mode = "DRY-RUN" if args.dry_run else "ЗАПИСЬ"
    log.info("Импорт в БД, режим=%s ...", mode)
    stats = import_to_db(conn, records, dry_run=args.dry_run)

    conn.close()

    log.info("─" * 50)
    log.info(
        "Итого: %d в КПТ | %d обновлено | %d создано | %d с геометрией | %d ошибок",
        stats["total"], stats["updated"], stats["created"],
        stats["geom_set"], stats["errors"],
    )

    # Вывод JSON для API
    print(json.dumps(stats, ensure_ascii=False))


if __name__ == "__main__":
    main()
