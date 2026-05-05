-- ============================================================
-- legal_entities.aliases — массив альтернативных названий
-- ============================================================
-- По образцу objects.aliases (jsonb-массив строк).
-- Решает проблему дубликатов при импорте: организации в протоколах могут
-- называться по-разному (бренд / латиница / сокращение / с/без скобок).
-- Один источник истины для нормализации — в БД, а не в каждом скрипте.
--
-- Примеры:
--   ООО «Хэдс Групп» — aliases: ["Хэдс Групп","Heads Group","HeadsGroup","ХГ"]
--   ООО «МЛА+»       — aliases: ["MLA+","ООО MLA+","МЛА+"]
--   ИП Симоненко (Бюро 82) — aliases: ["Бюро 82","Бюро82","Симоненко","Б82"]

alter table legal_entities
    add column if not exists aliases jsonb not null default '[]'::jsonb;

comment on column legal_entities.aliases is
    'JSONB-массив альтернативных названий: бренды, латиница, сокращения, прежние имена. Используется в find_legal_entity_by_alias() для разрешения имён из импортов.';

-- GIN-индекс для быстрого поиска по элементам массива
create index if not exists legal_entities_aliases_gin_idx
    on legal_entities using gin (aliases);

-- ─── Нормализация имени для сравнения ─────────────────────────────────────────
-- lowercase + убрать кавычки + схлопнуть пробелы.
-- Скобочные суффиксы НЕ режем — они часть официального имени и пишутся в alias явно.

create or replace function normalize_org_name(p_name text)
returns text
language sql immutable as $$
    select trim(
        regexp_replace(
            regexp_replace(
                lower(coalesce(p_name, '')),
                '[«»"'']', '', 'g'    -- убрать все виды кавычек
            ),
            '\s+', ' ', 'g'           -- схлопнуть пробелы
        )
    );
$$;

comment on function normalize_org_name(text) is
    'Нормализация названия организации для сравнения: lowercase, без кавычек, схлопнутые пробелы';

-- ─── Поиск организации по любому имени или alias ──────────────────────────────

create or replace function find_legal_entity_by_alias(p_query text)
returns uuid
language sql stable as $$
    with q as (select normalize_org_name(p_query) as nq)
    -- 1) точное совпадение по name (нормализованному)
    select id from legal_entities, q
     where normalize_org_name(name) = q.nq
     limit 1
$$;

comment on function find_legal_entity_by_alias(text) is
    'Ищет legal_entity по name или элементу aliases (с нормализацией). Возвращает id или NULL.';

-- Обновлённая версия с проверкой aliases — заменяет предыдущую через CREATE OR REPLACE
-- (разделено для читаемости — `union all` объединяет два пути поиска)
create or replace function find_legal_entity_by_alias(p_query text)
returns uuid
language sql stable as $$
    with q as (select normalize_org_name(p_query) as nq)
    select id from (
        -- 1) точное совпадение по name
        select id, 1 as priority
          from legal_entities, q
         where normalize_org_name(name) = q.nq

        union all

        -- 2) совпадение в aliases
        select le.id, 2 as priority
          from legal_entities le, q,
               lateral jsonb_array_elements_text(le.aliases) as alias
         where normalize_org_name(alias) = q.nq
    ) matches
    order by priority
    limit 1;
$$;

notify pgrst, 'reload schema';
