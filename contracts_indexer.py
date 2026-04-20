"""
contracts_indexer.py — индексатор договоров ЗПР
Проект: «Золотые Пески России»

Сканирует папки договоров, извлекает текст (DOCX / PDF / ABBYY OCR),
парсит стороны / этапы / акты / письма, пишет JSON-индекс.

Запуск:
    python contracts_indexer.py            # полная синхронизация
    python contracts_indexer.py --dry-run  # только показать найденные папки
    python contracts_indexer.py --id ХГ-2025-001  # переиндексировать один договор
"""

import sys
import json
import re
import subprocess
import argparse
from datetime import date
from pathlib import Path

sys.stdout.reconfigure(encoding='utf-8')

from config import (
    BASE_DIR, SOURCE_DIRS_CONTRACTS as SOURCE_DIRS,
    INDEX_DIR, REGISTRY, CONTRACTS_DIR,
    FINECMD_PATH, ABBYY_LANG, OBJECT_MAP,
)

FINECMD_PATH = r"C:\Program Files (x86)\ABBYY FineReader 15\FineCmd.exe"
ABBYY_LANG   = "Russian,English"

# Маппинг старых названий объектов (Bitrix24) → коды
OBJECT_MAP = {
    "01": "01_APT_375",
    "02": "02_FAM_800",
    "03": "03_FAM_500",
    "04": "04_HLT_260",
    "05": "05_EMR_340",
    "06": "06_CLB_350",
    "07": "07_SEL_400",
    "08": "08_PRS_450",
}

# Паттерны классификации файлов (ищем в любом месте имени)
FILE_PATTERNS = {
    "amendment": re.compile(r"(Доп\.?\s*соглашение|ДС[-\s]?\d)", re.I),
    "act":       re.compile(r"(Акт|АКТ)\b", re.I),
    "letter":    re.compile(r"(Письмо|Уведомление|Запрос|Претензия)\b", re.I),
    "contract":  re.compile(r"(Договор|Contract|№\s*\d)", re.I),  # последний — самый широкий
}

TODAY = date.today().isoformat()

# ─── утилиты ─────────────────────────────────────────────────────────────────

def classify_file(filename: str) -> str:
    for ftype, pat in FILE_PATTERNS.items():
        if pat.search(filename):   # search, not match — ищем в любом месте имени
            return ftype
    return "other"


def extract_text_docx(path: Path) -> str:
    try:
        import docx
        doc = docx.Document(str(path))
        return "\n".join(p.text for p in doc.paragraphs)
    except Exception as e:
        print(f"  [DOCX] ошибка {path.name}: {e}")
        return ""


def extract_text_pdf(path: Path) -> str:
    # Сначала pdfplumber
    try:
        import pdfplumber
        with pdfplumber.open(str(path)) as pdf:
            pages = [p.extract_text() or "" for p in pdf.pages]
            text = "\n".join(pages).strip()
            if len(text) > 100:
                return text
    except Exception as e:
        print(f"  [PDF] pdfplumber ошибка {path.name}: {e}")

    # Fallback: ABBYY OCR
    txt_path = path.with_suffix(".txt")
    if txt_path.exists():
        return txt_path.read_text(encoding="utf-8", errors="ignore")

    if not Path(FINECMD_PATH).exists():
        print(f"  [OCR] ABBYY не найден, пропускаем {path.name}")
        return ""

    print(f"  [OCR] ABBYY → {path.name}")
    try:
        subprocess.run(
            [FINECMD_PATH, str(path), "/lang", ABBYY_LANG, "/out", str(txt_path)],
            check=True, timeout=120,
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        )
        if txt_path.exists():
            return txt_path.read_text(encoding="utf-8", errors="ignore")
    except Exception as e:
        print(f"  [OCR] ошибка: {e}")
    return ""


def extract_text(path: Path) -> str:
    ext = path.suffix.lower()
    if ext == ".docx":
        return extract_text_docx(path)
    elif ext == ".pdf":
        return extract_text_pdf(path)
    elif ext == ".txt":
        return path.read_text(encoding="utf-8", errors="ignore")
    return ""


# ─── парсинг содержимого ──────────────────────────────────────────────────────

def parse_contract_number(text: str) -> str:
    m = re.search(r"[Дд]оговор\s*[№#]\s*([\w\-/\.]+)", text)
    return m.group(1).strip() if m else ""


def parse_contract_date(text: str) -> str:
    m = re.search(r"\bот\s+(\d{1,2}[\.\-]\d{1,2}[\.\-]\d{2,4})", text)
    if m:
        raw = m.group(1).replace("-", ".")
        parts = raw.split(".")
        if len(parts) == 3:
            d, mo, y = parts
            if len(y) == 2:
                y = "20" + y
            return f"{y}-{mo.zfill(2)}-{d.zfill(2)}"
    return ""


def parse_parties(text: str) -> dict:
    result = {"customer": "", "contractor": ""}
    m = re.search(r"[Зз]аказчик[:\s]+([^\n,]{5,60})", text)
    if m:
        result["customer"] = m.group(1).strip()
    m = re.search(r"[Пп]одрядчик[:\s]+([^\n,]{5,60})", text)
    if m:
        result["contractor"] = m.group(1).strip()
    return result


def parse_stages(text: str, use_llm_fallback: bool = True) -> list:
    """Извлекает таблицу этапов из текста договора."""
    stages = []
    # Ищем строки вида: 1. Форэскиз ... до 15.01.2026
    pattern = re.compile(
        r"(\d+)[.)]\s+"                          # номер
        r"([^\n\d]{5,80}?)\s+"                   # название
        r"(?:до|не позднее|срок[:\s]+)"          # маркер срока
        r"\s*(\d{1,2}[\.\-]\d{1,2}[\.\-]\d{2,4})",  # дата
        re.IGNORECASE
    )
    for m in pattern.finditer(text):
        num = int(m.group(1))
        title = m.group(2).strip().rstrip(".")
        raw_date = m.group(3).replace("-", ".")
        parts = raw_date.split(".")
        if len(parts) == 3:
            d, mo, y = parts
            if len(y) == 2:
                y = "20" + y
            due = f"{y}-{mo.zfill(2)}-{d.zfill(2)}"
        else:
            due = raw_date
        stages.append({"num": num, "title": title, "due": due,
                        "deliverables": [], "status": "pending", "source_page": 0})

    # Если регулярки ничего не нашли — пробуем через LLM
    if not stages and use_llm_fallback and text:
        print("  [LLM] регулярки не нашли этапы, спрашиваем модель...")
        try:
            from llm_client import extract_stages_llm
            stages = extract_stages_llm(text)
            if stages:
                print(f"  [LLM] извлечено этапов: {len(stages)}")
        except Exception as e:
            print(f"  [LLM] ошибка: {e}")

    return stages


def parse_amendment_summary(text: str) -> str:
    """Краткое содержание доп. соглашения."""
    for kw in ["изменить", "продлить", "дополнить", "исключить"]:
        m = re.search(rf"({kw}[^.;]{{5,150}})[.;]", text, re.IGNORECASE)
        if m:
            return m.group(1).strip()
    return text[:200].replace("\n", " ").strip()


def parse_act_stage(text: str) -> int:
    """Номер этапа из акта."""
    m = re.search(r"[Ээ]тап[а]?\s*[№#]?\s*(\d+)", text)
    return int(m.group(1)) if m else 0


def compute_stage_statuses(stages: list, acts: list) -> list:
    """Проставляет статус каждому этапу на основе наличия акта и срока."""
    act_stages = {a["stage_num"] for a in acts if a["stage_num"]}
    today = date.today()
    for s in stages:
        if s["num"] in act_stages:
            s["status"] = "done"
        elif s["due"]:
            try:
                due_date = date.fromisoformat(s["due"])
                s["status"] = "overdue" if today > due_date else "pending"
            except ValueError:
                s["status"] = "pending"
        else:
            s["status"] = "pending"
    return stages


# ─── обход папок ─────────────────────────────────────────────────────────────

def find_contract_folders(source_dir: Path) -> list[dict]:
    """
    Возвращает список словарей с полями:
      folder, object_code, date_str, contract_type, contractor_raw
    """
    results = []
    if not source_dir.exists():
        return results

    # Obsidian: ОБЪЕКТЫ/{Код Объект}/ДОГОВОРА/YYYY_MM_DD Тип Подрядчик/
    if "ОБЪЕКТЫ" in str(source_dir):
        for obj_dir in source_dir.iterdir():
            if not obj_dir.is_dir():
                continue
            code = obj_dir.name.split()[0]  # "02_FAM_800"
            договора_dir = obj_dir / "ДОГОВОРА"
            if not договора_dir.exists():
                continue
            for folder in договора_dir.iterdir():
                if not folder.is_dir():
                    continue
                m = re.match(r"(\d{4}_\d{2}_\d{2})\s+(.+)", folder.name)
                if not m:
                    continue
                date_str = m.group(1).replace("_", "-")
                rest = m.group(2)
                results.append({
                    "folder": folder,
                    "object_code": code,
                    "date_str": date_str,
                    "label": rest,
                    "source": "obsidian",
                })

    # Bitrix24: {NN_Объект}/{NN.N_Этап_Подрядчик}/
    else:
        for obj_dir in source_dir.iterdir():
            if not obj_dir.is_dir():
                continue
            m_obj = re.match(r"^(\d{2})[_\-]", obj_dir.name)
            if not m_obj:
                continue
            nn = m_obj.group(1)
            code = OBJECT_MAP.get(nn)
            if not code:
                continue
            for folder in obj_dir.iterdir():
                if not folder.is_dir():
                    continue
                results.append({
                    "folder": folder,
                    "object_code": code,
                    "date_str": "",   # дату возьмём из текста договора
                    "label": folder.name,
                    "source": "bitrix24",
                })

    return results


def make_contract_id(object_code: str, date_str: str, contractor_raw: str, seq: int) -> str:
    """ХГ-2025-001 — стабильный идентификатор на основе объекта + года + порядка."""
    # Определяем код подрядчика по строке contractor_raw
    contractor_codes = {
        "хэдс": "ХГ", "хедс": "ХГ", "heads": "ХГ",
        "мла": "МЛА", "mla": "МЛА",
        "8d": "8D", "8д": "8D", "акулова": "8D",
        "бюро": "Б82", "симоненко": "Б82",
    }
    code = "ДОГ"
    for key, val in contractor_codes.items():
        if key in contractor_raw.lower():
            code = val
            break
    year = date_str[:4] if date_str else "0000"
    return f"{code}-{year}-{seq:03d}"


# ─── индексирование одной папки договора ─────────────────────────────────────

def index_contract_folder(info: dict, seq: int) -> dict | None:
    folder: Path = info["folder"]
    object_code: str = info["object_code"]

    print(f"\n📁 {folder.name} [{object_code}]")

    files = [f for f in folder.iterdir() if f.is_file() and
             f.suffix.lower() in (".pdf", ".docx", ".txt")]
    if not files:
        print("  пусто, пропускаем")
        return None

    contract_text = ""
    source_file = ""
    amendments = []
    acts = []
    letters = []

    for f in sorted(files):
        ftype = classify_file(f.name)
        text = extract_text(f)
        # Путь относительно BASE_DIR, если файл внутри; иначе абсолютный
        try:
            rel = str(f.relative_to(BASE_DIR))
        except ValueError:
            rel = str(f)

        if ftype == "contract" and not contract_text:
            contract_text = text
            source_file = rel
            print(f"  ✅ договор: {f.name}")

        elif ftype == "amendment":
            num_m = re.search(r"[№#\s](\d+)", f.name)
            amend_num = int(num_m.group(1)) if num_m else len(amendments) + 1
            date_m = re.search(r"от\s*(\d{2})\.(\d{2})\.(\d{2,4})", f.name)
            amend_date = ""
            if date_m:
                d, mo, y = date_m.groups()
                if len(y) == 2:
                    y = "20" + y
                amend_date = f"{y}-{mo}-{d}"
            summary = parse_amendment_summary(text) if text else ""
            # Ищем этапы в ДС — они переопределяют этапы основного договора
            amend_stages = parse_stages(text, use_llm_fallback=True) if text else []
            amendments.append({
                "num": amend_num,
                "date": amend_date,
                "summary": summary,
                "stages": amend_stages,   # пустой список если этапов нет
                "source_file": rel,
                "source_page": 1,
            })
            if amend_stages:
                print(f"  📝 ДС #{amend_num}: {f.name}  → переопределяет этапы: {len(amend_stages)}")
            else:
                print(f"  📝 ДС #{amend_num}: {f.name}")

        elif ftype == "act":
            act_date = info["date_str"]
            date_m = re.search(r"от\s*(\d{2})\.(\d{2})\.(\d{2,4})", f.name + " " + text[:200])
            if date_m:
                d, mo, y = date_m.groups()
                if len(y) == 2:
                    y = "20" + y
                act_date = f"{y}-{mo}-{d}"
            stage_num = parse_act_stage(text)
            acts.append({
                "stage_num": stage_num,
                "date": act_date,
                "source_file": rel,
                "source_page": 1,
            })
            print(f"  📋 Акт этап {stage_num}: {f.name}")

        elif ftype == "letter":
            direction = "incoming" if re.search(r"вх|входящ|от\s+подряд", text[:300], re.I) else "outgoing"
            letters.append({
                "date": info["date_str"],
                "direction": direction,
                "summary": text[:150].replace("\n", " ").strip(),
                "source_file": rel,
                "source_page": 1,
            })
            print(f"  ✉️ Письмо ({direction}): {f.name}")

    if not contract_text and not amendments:
        print("  нет основных документов, пропускаем")
        return None

    # Парсим основной договор
    number = parse_contract_number(contract_text)
    # Дата папки (info["date_str"]) — приоритет; текст — только если папка без даты
    signed = info["date_str"] or parse_contract_date(contract_text)
    parties = parse_parties(contract_text)
    stages = parse_stages(contract_text)

    # ДС переопределяют этапы основного договора — берём последнее ДС с этапами
    # (ДС сортированы по номеру через sorted(files) при чтении)
    for amend in sorted(amendments, key=lambda a: a["num"]):
        if amend.get("stages"):
            stages = amend["stages"]
            print(f"  ℹ️  Этапы взяты из ДС #{amend['num']} ({amend['date']})")

    stages = compute_stage_statuses(stages, acts)

    contractor_raw = parties.get("contractor") or info["label"]
    contract_id = make_contract_id(object_code, signed, contractor_raw, seq)

    record = {
        "contract_id":  contract_id,
        "object_code":  object_code,
        "contractor":   contractor_raw,
        "number":       number,
        "type":         info["label"],
        "signed":       signed,
        "source_file":  source_file,
        "parsed":       bool(contract_text),
        "indexed_at":   TODAY,
        "stages":       stages,
        "amendments":   amendments,
        "acts":         acts,
        "letters":      letters,
    }
    return record


# ─── реестр ──────────────────────────────────────────────────────────────────

def load_registry() -> dict:
    if REGISTRY.exists():
        return json.loads(REGISTRY.read_text(encoding="utf-8"))
    return {}


def save_registry(registry: dict):
    REGISTRY.write_text(
        json.dumps(registry, ensure_ascii=False, indent=2),
        encoding="utf-8"
    )


def save_contract(record: dict):
    out = CONTRACTS_DIR / f"{record['contract_id']}.json"
    out.write_text(
        json.dumps(record, ensure_ascii=False, indent=2),
        encoding="utf-8"
    )


def registry_entry(record: dict) -> dict:
    overdue = sum(1 for s in record["stages"] if s["status"] == "overdue")
    done    = sum(1 for s in record["stages"] if s["status"] == "done")
    return {
        "contract_id":  record["contract_id"],
        "object_code":  record["object_code"],
        "contractor":   record["contractor"],
        "type":         record["type"],
        "signed":       record["signed"],
        "stages_total": len(record["stages"]),
        "stages_done":  done,
        "stages_overdue": overdue,
        "amendments":   len(record["amendments"]),
        "indexed_at":   record["indexed_at"],
    }


# ─── синхронизация Bitrix24 → Obsidian ───────────────────────────────────────

BITRIX_SOURCE = Path(r"D:\Bitrix24\Концепции отелей\01_УПРАВЛЕНИЕ ПРОЕКТОМ\02_ДОГОВОРА_ЗПР")

def sync_from_bitrix24():
    """
    Копирует новые папки договоров из Bitrix24 в ОБЪЕКТЫ/{Код}/ДОГОВОРА/.
    Не перезаписывает существующие файлы.
    """
    import shutil
    if not BITRIX_SOURCE.exists():
        print("  Bitrix24 недоступен, пропускаем синхронизацию")
        return

    copied = 0
    for obj_dir in BITRIX_SOURCE.iterdir():
        if not obj_dir.is_dir():
            continue
        m = re.match(r"^(\d{2})[_\-]", obj_dir.name)
        if not m:
            continue
        code = OBJECT_MAP.get(m.group(1))
        if not code:
            continue

        # Целевая папка в Obsidian
        target_obj = BASE_DIR / "ОБЪЕКТЫ" / next(
            (d.name for d in (BASE_DIR / "ОБЪЕКТЫ").iterdir() if d.name.startswith(code)),
            code,
        )
        target_contracts = target_obj / "ДОГОВОРА"
        target_contracts.mkdir(parents=True, exist_ok=True)

        # Собираем все имена файлов уже имеющихся в Obsidian для этого объекта
        existing_filenames: set[str] = set()
        for existing_folder in target_contracts.iterdir():
            if existing_folder.is_dir():
                for ef in existing_folder.iterdir():
                    if ef.is_file():
                        existing_filenames.add(ef.name)

        for contract_folder in obj_dir.iterdir():
            if not contract_folder.is_dir():
                continue

            # Файлы этой папки из Bitrix24
            src_files = [f for f in contract_folder.iterdir() if f.is_file()
                         and f.suffix.lower() in (".pdf", ".docx", ".txt")]
            if not src_files:
                continue

            # Если все файлы уже есть в Obsidian — пропускаем
            new_files = [f for f in src_files if f.name not in existing_filenames]
            if not new_files:
                continue

            # Ищем дату подписания в имени файла договора
            date_str = ""
            for f in src_files:
                if classify_file(f.name) == "contract":
                    dm = re.search(r"от\s*(\d{2})\.(\d{2})\.(\d{2,4})", f.name)
                    if dm:
                        d, mo, y = dm.groups()
                        if len(y) == 2:
                            y = "20" + y
                        date_str = f"{y}_{mo}_{d}"
                    break

            if not date_str:
                date_str = "0000_00_00"

            label = re.sub(r"^\d+\.\d+_", "", contract_folder.name).replace("_", " ")
            target_name = f"{date_str} {label}"
            target_folder = target_contracts / target_name
            target_folder.mkdir(parents=True, exist_ok=True)

            for f in new_files:
                dst = target_folder / f.name
                shutil.copy2(f, dst)
                print(f"  + [{code}] {target_name}/{f.name}")
                copied += 1
                existing_filenames.add(f.name)

    if copied:
        print(f"  ✅ синхронизировано файлов: {copied}")
    else:
        print("  ✅ всё актуально, новых файлов нет")


# ─── main ─────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="Индексатор договоров ЗПР")
    parser.add_argument("--dry-run", action="store_true", help="только показать найденные папки")
    parser.add_argument("--no-sync", action="store_true", help="не синхронизировать с Bitrix24")
    parser.add_argument("--id", help="переиндексировать один договор по ID")
    args = parser.parse_args()

    CONTRACTS_DIR.mkdir(parents=True, exist_ok=True)

    # Шаг 1: синхронизация Bitrix24 → Obsidian
    if not args.no_sync and not args.dry_run:
        print("\n🔄 Синхронизация Bitrix24 → Obsidian...")
        sync_from_bitrix24()

    # Шаг 2: индексирование только из Obsidian
    print("\n🔍 Сканирование папок договоров (Obsidian)...")
    all_folders = []
    obsidian_source = BASE_DIR / "ОБЪЕКТЫ"
    folders = find_contract_folders(obsidian_source)
    print(f"  найдено папок: {len(folders)}")
    all_folders.extend(folders)

    if args.dry_run:
        for i, f in enumerate(all_folders, 1):
            print(f"  {i:3d}. [{f['object_code']}] {f['folder'].name}")
        return

    registry = load_registry()
    indexed = 0
    errors = 0

    for seq, info in enumerate(all_folders, 1):
        try:
            record = index_contract_folder(info, seq)
            if record is None:
                continue
            save_contract(record)
            registry[record["contract_id"]] = registry_entry(record)
            indexed += 1
        except Exception as e:
            print(f"  ❌ ошибка: {e}")
            errors += 1

    save_registry(registry)

    print(f"\n{'='*50}")
    print(f"✅ Проиндексировано договоров: {indexed}")
    print(f"❌ Ошибок: {errors}")
    print(f"📄 Реестр: {REGISTRY}")
    print(f"📁 Индекс: {CONTRACTS_DIR}")


if __name__ == "__main__":
    main()
