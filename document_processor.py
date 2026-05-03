"""
document_processor.py — постобработка документа после сохранения в БД.

1. Создаёт папку в хранилище (STORAGE_DIR / doc.folder_path)
2. Копирует переданные файлы в папку
3. Извлекает текст из PDF-файлов в папке
4. Нарезает на чанки, генерирует эмбеддинги, сохраняет в pgvector

Запуск:
    python document_processor.py --doc-id <uuid>
    python document_processor.py --doc-id <uuid> --files path/a.pdf path/b.pdf
    python document_processor.py --doc-id <uuid> --reindex   # только переиндексировать
"""

import argparse
import shutil
import sys
from pathlib import Path

sys.stdout.reconfigure(encoding='utf-8')

from config import STORAGE_DIR, SUPABASE_URL, SUPABASE_SECRET_KEY
from llm_client import get_embedding


def main():
    parser = argparse.ArgumentParser(description='Обработка документа ЗПР')
    parser.add_argument('--doc-id',  required=True, help='UUID документа в БД')
    parser.add_argument('--files',   nargs='*', default=[], help='Пути к файлам для копирования')
    parser.add_argument('--reindex', action='store_true', help='Только переиндексировать (без копирования)')
    args = parser.parse_args()

    try:
        from supabase import create_client
    except ImportError:
        print('Установите supabase-py: pip install supabase')
        sys.exit(1)

    sb = create_client(SUPABASE_URL, SUPABASE_SECRET_KEY)

    # ── 1. Получаем документ из БД ───────────────────────────────────────────
    resp = sb.table('documents').select('*').eq('id', args.doc_id).maybe_single().execute()
    if not resp.data:
        print(f'✗ Документ {args.doc_id} не найден в БД')
        sys.exit(1)

    doc = resp.data
    print(f'Документ: {doc["title"]} ({doc["id"]})')

    # ── 2. Создаём папку в хранилище ─────────────────────────────────────────
    folder_rel = doc.get('folder_path', '').strip('\\/')
    if not folder_rel:
        print('✗ folder_path не задан в документе')
        sys.exit(1)

    folder = STORAGE_DIR / Path(folder_rel.replace('\\', '/'))
    folder.mkdir(parents=True, exist_ok=True)
    print(f'✓ Папка: {folder}')

    # ── 3. Копируем файлы ─────────────────────────────────────────────────────
    if args.files and not args.reindex:
        for fpath in args.files:
            src = Path(fpath)
            if not src.exists():
                print(f'  ⚠ Файл не найден: {src}')
                continue
            dst = folder / src.name
            shutil.copy2(src, dst)
            print(f'  ✓ Скопирован: {dst.name}')

    # ── 4. Извлекаем текст из PDF ─────────────────────────────────────────────
    pdf_files = list(folder.glob('*.pdf')) + list(folder.glob('*.PDF'))
    if not pdf_files:
        print('  ℹ Нет PDF-файлов в папке — индексация пропущена')
        return

    print(f'  Файлов для индексации: {len(pdf_files)}')
    full_text = _extract_text(pdf_files)
    if not full_text.strip():
        print('  ⚠ Текст не извлечён (возможно, сканированные страницы без OCR)')
        return

    print(f'  Извлечено символов: {len(full_text):,}')

    # ── 5. Нарезаем на чанки ─────────────────────────────────────────────────
    chunks = _chunk_text(full_text)
    print(f'  Чанков: {len(chunks)}')

    # ── 6. Генерируем эмбеддинги и сохраняем ─────────────────────────────────
    _index_chunks(sb, doc['id'], chunks)

    # ── 7. Обновляем indexed_at ───────────────────────────────────────────────
    from datetime import datetime, timezone
    sb.table('documents').update({
        'indexed_at': datetime.now(timezone.utc).isoformat()
    }).eq('id', doc['id']).execute()
    print('✓ indexed_at обновлён')


def _extract_text(pdf_files: list[Path]) -> str:
    """Извлекает текст из PDF. Пробует pdfplumber, затем pypdf."""
    parts = []
    for f in pdf_files:
        text = _read_pdf(f)
        if text:
            parts.append(f'=== {f.name} ===\n{text}')
    return '\n\n'.join(parts)


def _read_pdf(path: Path) -> str:
    # pdfplumber (точнее для таблиц)
    try:
        import pdfplumber
        with pdfplumber.open(path) as pdf:
            pages = [p.extract_text() or '' for p in pdf.pages]
            return '\n'.join(pages)
    except Exception:
        pass

    # pypdf fallback
    try:
        from pypdf import PdfReader
        reader = PdfReader(str(path))
        return '\n'.join(page.extract_text() or '' for page in reader.pages)
    except Exception as e:
        print(f'  ⚠ Не удалось прочитать {path.name}: {e}')
        return ''


def _chunk_text(text: str, chunk_words: int = 400, overlap_words: int = 50) -> list[str]:
    """Нарезает текст на перекрывающиеся чанки по словам."""
    words = text.split()
    chunks = []
    i = 0
    while i < len(words):
        chunk = ' '.join(words[i: i + chunk_words])
        if chunk.strip():
            chunks.append(chunk)
        i += chunk_words - overlap_words
    return chunks


def _index_chunks(sb, document_id: str, chunks: list[str]) -> None:
    """Генерирует эмбеддинги и пишет в document_chunks (заменяет старые)."""
    # Удаляем старые чанки для этого документа
    sb.table('document_chunks').delete().eq('document_id', document_id).execute()

    rows = []
    for i, chunk in enumerate(chunks):
        print(f'  Эмбеддинг {i+1}/{len(chunks)}…', end='\r')
        emb = get_embedding(chunk)
        if emb is None:
            print(f'\n  ⚠ Чанк {i} пропущен (ошибка эмбеддинга)')
            continue
        rows.append({
            'document_id': document_id,
            'chunk_index': i,
            'chunk_text':  chunk,
            'embedding':   emb,
        })

    if rows:
        sb.table('document_chunks').insert(rows).execute()
        print(f'\n✓ Сохранено чанков: {len(rows)}')
    else:
        print('\n✗ Ни одного чанка не проиндексировано')


if __name__ == '__main__':
    main()
