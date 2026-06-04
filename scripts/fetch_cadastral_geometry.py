#!/usr/bin/env python
"""
scripts/fetch_cadastral_geometry.py

Получение контуров кадастровых участков из Публичной кадастровой карты (ПКК / НСПД)
и запись в cadastrals.geom (MultiPolygon, EPSG:4326).

Скрипт идемпотентный — можно запускать многократно:
  • по умолчанию обрабатывает только записи с geom IS NULL
  • с --force перезаписывает все
  • с --limit N обрабатывает не более N записей за запуск

Использование:
  python scripts/fetch_cadastral_geometry.py                 # заполнить пустые
  python scripts/fetch_cadastral_geometry.py --limit 20      # первые 20 пустых
  python scripts/fetch_cadastral_geometry.py --force          # все 185 (перезапись)
  python scripts/fetch_cadastral_geometry.py --kn 90:18:010179:2687  # один КН
  python scripts/fetch_cadastral_geometry.py --dry-run        # без записи в БД
  python scripts/fetch_cadastral_geometry.py --verbose        # подробный лог

Зависимость: rosreestr2coord  →  pip install rosreestr2coord
"""
from __future__ import annotations

import argparse
import json
import logging
import sys
import time
import traceback
from pathlib import Path

# Корень репо → import config
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import config  # type: ignore  # noqa: E402

from supabase import create_client  # noqa: E402

# ── Логирование ──────────────────────────────────────────────────────────────

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s  %(levelname)-7s  %(message)s",
    datefmt="%H:%M:%S",
)
log = logging.getLogger("fetch_geom")


# ── Получение геометрии из НСПД / ПКК ───────────────────────────────────────

def fetch_geometry_rosreestr2coord(
    cadastral_number: str, timeout: int = 30
) -> dict | None:
    """
    Получает GeoJSON-геометрию участка через библиотеку rosreestr2coord.
    Возвращает GeoJSON geometry dict или None если не найден.
    """
    try:
        from rosreestr2coord.parser import Area
    except ImportError:
        log.error(
            "Библиотека rosreestr2coord не установлена.\n"
            "  pip install rosreestr2coord"
        )
        sys.exit(1)

    try:
        area = Area(cadastral_number, timeout=timeout, with_log=False)
        geojson = area.to_geojson()

        if not geojson:
            return None

        # rosreestr2coord возвращает FeatureCollection или Feature
        if isinstance(geojson, str):
            geojson = json.loads(geojson)

        # Извлекаем geometry из разных форматов ответа
        geometry = None
        if geojson.get("type") == "FeatureCollection":
            features = geojson.get("features", [])
            if features:
                geometry = features[0].get("geometry")
        elif geojson.get("type") == "Feature":
            geometry = geojson.get("geometry")
        elif geojson.get("type") in ("Polygon", "MultiPolygon"):
            geometry = geojson
        else:
            log.warning("  Неожиданный формат GeoJSON: %s", geojson.get("type"))
            return None

        if not geometry or not geometry.get("coordinates"):
            return None

        return geometry

    except Exception as e:
        log.warning("  rosreestr2coord ошибка: %s", e)
        return None


def fetch_geometry_nspd_http(
    cadastral_number: str,
    timeout: int = 30,
    proxy: str | None = None,
) -> dict | None:
    """
    Запасной вариант: прямой HTTP-запрос к API ПКК.
    Используется если rosreestr2coord не работает для конкретного КН.

    ВАЖНО: pkk.rosreestr.ru блокирует не-российские IP.
    При необходимости используйте --proxy socks5://... или VPN.
    """
    import requests as rq

    headers = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
        "Accept": "application/json",
        "Referer": "https://pkk.rosreestr.ru/",
    }
    proxies = {"https": proxy, "http": proxy} if proxy else None

    try:
        # Шаг 1: поиск по кадастровому номеру
        search_url = (
            "https://pkk.rosreestr.ru/api/features/1"
            f"?text={cadastral_number}&limit=1&tolerance=4"
        )
        resp = rq.get(search_url, headers=headers, timeout=timeout, proxies=proxies)
        resp.raise_for_status()
        data = resp.json()

        features = data.get("features", [])
        if not features:
            return None

        feature = features[0]
        feature_id = feature.get("attrs", {}).get("id")
        if not feature_id:
            return None

        # Шаг 2: запрос полной геометрии
        geom_url = (
            f"https://pkk.rosreestr.ru/api/features/1/{feature_id}"
        )
        resp2 = rq.get(geom_url, headers=headers, timeout=timeout, proxies=proxies)
        resp2.raise_for_status()
        data2 = resp2.json()

        feature2 = data2.get("feature", {})
        geometry = feature2.get("geometry")

        if not geometry:
            # Некоторые участки не имеют геометрии в ПКК
            return None

        return geometry

    except rq.exceptions.Timeout:
        log.warning("  ПКК HTTP таймаут (сервер недоступен или заблокирован IP)")
        return None
    except rq.exceptions.RequestException as e:
        log.warning("  ПКК HTTP ошибка: %s", e)
        return None
    except Exception as e:
        log.warning("  ПКК HTTP неожиданная ошибка: %s", e)
        return None


# Глобальные настройки, устанавливаемые из main()
_fetch_timeout: int = 30
_fetch_proxy: str | None = None


def fetch_geometry(cadastral_number: str, method: str = "auto") -> dict | None:
    """
    Получает геометрию участка. Стратегия:
      auto   — сначала rosreestr2coord, потом HTTP-fallback
      r2c    — только rosreestr2coord
      http   — только прямой HTTP к ПКК
    """
    geom = None

    if method in ("auto", "r2c"):
        geom = fetch_geometry_rosreestr2coord(cadastral_number, timeout=_fetch_timeout)

    if geom is None and method in ("auto", "http"):
        geom = fetch_geometry_nspd_http(
            cadastral_number, timeout=_fetch_timeout, proxy=_fetch_proxy
        )

    return geom


# ── Нормализация в MultiPolygon ──────────────────────────────────────────────

def ensure_multipolygon(geometry: dict) -> dict:
    """
    Приводит Polygon к MultiPolygon для единообразия хранения.
    """
    geom_type = geometry.get("type")
    if geom_type == "MultiPolygon":
        return geometry
    elif geom_type == "Polygon":
        return {
            "type": "MultiPolygon",
            "coordinates": [geometry["coordinates"]],
        }
    else:
        raise ValueError(f"Неподдерживаемый тип геометрии: {geom_type}")


# ── Основная логика ──────────────────────────────────────────────────────────

def get_cadastrals(
    sb, *, force: bool = False, kn: str | None = None, limit: int | None = None
) -> list[dict]:
    """Выбирает кадастры для обработки."""
    query = sb.table("cadastrals").select("id, cadastral_number").eq("active", True)

    if kn:
        query = query.eq("cadastral_number", kn)
    elif not force:
        query = query.is_("geom", "null")

    query = query.order("cadastral_number")

    if limit:
        query = query.limit(limit)

    result = query.execute()
    return result.data or []


def update_geometry(sb, cadastral_id: str, geojson_geom: dict) -> bool:
    """Записывает геометрию в БД через Supabase PostGIS."""
    # Supabase REST принимает GeoJSON как строку для geometry-колонки
    geom_str = json.dumps(geojson_geom)

    result = (
        sb.table("cadastrals")
        .update({"geom": geom_str})
        .eq("id", cadastral_id)
        .execute()
    )
    return bool(result.data)


def load_from_file(filepath: str) -> dict[str, dict]:
    """
    Загрузка геометрий из JSON-файла.
    Формат: {"90:18:010179:2687": {GeoJSON geometry}, ...}
    Или FeatureCollection, где feature.id = cadastral_number.
    """
    with open(filepath, "r", encoding="utf-8") as f:
        data = json.load(f)

    result: dict[str, dict] = {}

    if isinstance(data, dict):
        if data.get("type") == "FeatureCollection":
            for feat in data.get("features", []):
                kn = feat.get("id") or feat.get("properties", {}).get("cadastral_number")
                geom = feat.get("geometry")
                if kn and geom:
                    result[kn] = geom
        else:
            # Прямой формат {kn: geometry}
            for kn, geom in data.items():
                if isinstance(geom, dict) and geom.get("type"):
                    result[kn] = geom

    log.info("Загружено %d геометрий из %s", len(result), filepath)
    return result


def main():
    parser = argparse.ArgumentParser(
        description="Получение контуров кадастров из ПКК / НСПД"
    )
    parser.add_argument(
        "--dry-run", action="store_true",
        help="Не записывать в БД, только показать что будет сделано"
    )
    parser.add_argument(
        "--force", action="store_true",
        help="Перезаписать геометрию для всех кадастров (включая уже заполненные)"
    )
    parser.add_argument(
        "--limit", type=int, default=None,
        help="Максимальное количество записей за запуск"
    )
    parser.add_argument(
        "--kn", type=str, default=None,
        help="Обработать один конкретный кадастровый номер (напр. 90:18:010179:2687)"
    )
    parser.add_argument(
        "--method", choices=["auto", "r2c", "http"], default="auto",
        help="Метод получения геометрии: auto (по умолчанию), r2c (rosreestr2coord), http (прямой ПКК)"
    )
    parser.add_argument(
        "--delay", type=float, default=1.5,
        help="Задержка между запросами в секундах (по умолчанию 1.5)"
    )
    parser.add_argument(
        "--timeout", type=int, default=30,
        help="Таймаут HTTP-запроса в секундах (по умолчанию 30)"
    )
    parser.add_argument(
        "--proxy", type=str, default=None,
        help="SOCKS5/HTTP прокси для доступа к ПКК (напр. socks5://127.0.0.1:1080)"
    )
    parser.add_argument(
        "--from-file", type=str, default=None,
        metavar="PATH",
        help="Загрузить геометрии из JSON-файла вместо ПКК (формат: {kn: geojson} или FeatureCollection)"
    )
    parser.add_argument(
        "--verbose", action="store_true",
        help="Подробный лог"
    )
    args = parser.parse_args()

    if args.verbose:
        log.setLevel(logging.DEBUG)

    # Установка глобальных настроек для fetch-функций
    global _fetch_timeout, _fetch_proxy
    _fetch_timeout = args.timeout
    _fetch_proxy = args.proxy

    # ── Подключение к Supabase ───────────────────────────────────────────────
    sb = create_client(config.SUPABASE_URL, config.SUPABASE_SECRET_KEY)

    # ── Загрузка из файла (если указан) ─────────────────────────────────────
    file_geom: dict[str, dict] = {}
    if args.from_file:
        file_geom = load_from_file(args.from_file)
        if not file_geom:
            log.error("Файл не содержит геометрий, выход")
            sys.exit(1)

    # ── Выборка кадастров ────────────────────────────────────────────────────
    cadastrals = get_cadastrals(
        sb, force=args.force, kn=args.kn, limit=args.limit
    )

    # Если --from-file, фильтруем только те КН, которые есть в файле
    if file_geom and not args.kn:
        cadastrals = [c for c in cadastrals if c["cadastral_number"] in file_geom]

    total = len(cadastrals)
    if total == 0:
        log.info("Нет кадастров для обработки (все уже имеют геометрию?)")
        return

    source = f"файл ({args.from_file})" if args.from_file else f"ПКК ({args.method})"
    mode = "DRY-RUN" if args.dry_run else "ЗАПИСЬ"
    log.info(
        "Старт: %d кадастров, источник=%s, режим=%s",
        total, source, mode,
    )

    # ── Обработка ────────────────────────────────────────────────────────────
    ok = 0
    skipped = 0
    failed = 0

    for i, cad in enumerate(cadastrals, 1):
        kn = cad["cadastral_number"]
        cad_id = cad["id"]

        log.info("[%d/%d] %s", i, total, kn)

        try:
            # Источник геометрии: файл или ПКК
            if file_geom:
                geometry = file_geom.get(kn)
            else:
                geometry = fetch_geometry(kn, method=args.method)

            if geometry is None:
                log.warning("  → геометрия не найдена, пропуск")
                skipped += 1
                continue

            # Нормализация в MultiPolygon
            geometry = ensure_multipolygon(geometry)
            n_rings = len(geometry.get("coordinates", []))
            log.info("  → найден MultiPolygon (%d полигон(ов))", n_rings)

            if args.dry_run:
                log.info("  → [DRY-RUN] пропуск записи")
                ok += 1
            else:
                success = update_geometry(sb, cad_id, geometry)
                if success:
                    log.info("  → записано в БД")
                    ok += 1
                else:
                    log.error("  → ошибка записи в БД")
                    failed += 1

        except Exception:
            log.error("  → исключение:\n%s", traceback.format_exc())
            failed += 1

        # Rate limiting только при сетевых запросах (не при --from-file)
        if not file_geom and i < total:
            time.sleep(args.delay)

    # ── Итоги ────────────────────────────────────────────────────────────────
    log.info("─" * 50)
    log.info(
        "Итого: %d обработано, %d записано, %d не найдено, %d ошибок",
        total, ok, skipped, failed,
    )

    if args.dry_run:
        log.info("Режим DRY-RUN — данные НЕ записывались в БД")


if __name__ == "__main__":
    main()
