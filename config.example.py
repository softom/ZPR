"""
config.example.py — шаблон конфигурации.
Скопируйте в config.py и заполните ключи.
"""

from pathlib import Path

BASE_DIR = Path(r"D:\Dropbox\Obsidian\Tigra\ЗПР")  # путь к Obsidian-хранилищу

SOURCE_DIRS_CONTRACTS = [
    BASE_DIR / "ОБЪЕКТЫ",
    Path(r"D:\Bitrix24\Концепции отелей\01_УПРАВЛЕНИЕ ПРОЕКТОМ\02_ДОГОВОРА_ЗПР"),
]

INDEX_DIR     = BASE_DIR / "_ОБЩЕЕ" / "ДОГОВОРА_ИНДЕКС"
CONTRACTS_DIR = INDEX_DIR / "contracts"
REGISTRY      = INDEX_DIR / "00_registry.json"

OBJECTS_DIR     = BASE_DIR / "ОБЪЕКТЫ"
CONTRACTORS_DIR = BASE_DIR / "ПОДРЯДЧИКИ"
REPORTS_DIR     = BASE_DIR / "ОТЧЁТЫ"
SCHEDULE_DIR    = BASE_DIR / "ГРАФИК"

FINECMD_PATH = r"C:\Program Files (x86)\ABBYY FineReader 15\FineCmd.exe"
ABBYY_LANG   = "Russian,English"

POLZA_API_KEY  = ""   # https://polza.ai/dashboard/api-keys
POLZA_BASE_URL = "https://polza.ai/api/v1"

PINECONE_API_KEY   = ""         # https://app.pinecone.io/
PINECONE_INDEX     = "zpr-docs"
PINECONE_NAMESPACE = "zpr"
