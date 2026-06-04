-- ============================================================================
-- strategic_topics.seq — трёхзначный порядковый номер темы
-- ============================================================================
-- Используется для отображения «001», «002» в списке/карточке и для сортировки.
-- При INSERT без явного seq — авто-присваивается max(seq)+1 через триггер.
-- Уникален. Тип smallint (диапазон до 32767, нам достаточно 1..999).
-- ============================================================================

-- ─── Колонка ─────────────────────────────────────────────────────────────
alter table strategic_topics add column seq smallint;

-- ─── Backfill по report-section order ─────────────────────────────────────
-- Порядок повторяет структуру аналитического отчёта ТЗ-ЮГ за март 2026
-- (разделы 3.1–3.7 → 1–7, Таблица I → 8). Прочие темы (например, созданные
-- оператором в UI) получают следующий свободный номер по дате создания.
update strategic_topics set seq = 1 where code = 'ENVIRONMENT';
update strategic_topics set seq = 2 where code = 'MAGISTRAL_NETS';
update strategic_topics set seq = 3 where code = 'ROAD_TRANSFER';
update strategic_topics set seq = 4 where code = 'CONCEPT_TRANSITION';
update strategic_topics set seq = 5 where code = 'SCHEDULE_GOVERNANCE';
update strategic_topics set seq = 6 where code = 'SURVEYS';
update strategic_topics set seq = 7 where code = 'PERSONNEL';
update strategic_topics set seq = 8 where code = 'PPT_LINEAR';

-- Прочие (без code или с пользовательскими code-ами) — присваиваем по
-- created_at в порядке создания, продолжая нумерацию.
do $$
declare
    r record;
    next_seq smallint;
begin
    select coalesce(max(seq), 0) + 1 into next_seq from strategic_topics;
    for r in
        select id from strategic_topics
        where seq is null
        order by created_at
    loop
        update strategic_topics set seq = next_seq where id = r.id;
        next_seq := next_seq + 1;
    end loop;
end $$;

-- ─── NOT NULL + UNIQUE ───────────────────────────────────────────────────
alter table strategic_topics alter column seq set not null;
alter table strategic_topics add constraint strategic_topics_seq_unique unique (seq);

create index strategic_topics_seq_idx on strategic_topics (seq);

-- ─── Триггер авто-присваивания seq ───────────────────────────────────────
create or replace function strategic_topics_default_seq()
returns trigger language plpgsql as $$
begin
    if new.seq is null then
        select coalesce(max(seq), 0) + 1 into new.seq from strategic_topics;
    end if;
    return new;
end$$;

create trigger strategic_topics_set_default_seq
    before insert on strategic_topics
    for each row execute function strategic_topics_default_seq();

-- ─── Комментарий ─────────────────────────────────────────────────────────
comment on column strategic_topics.seq is
    'Трёхзначный порядковый номер темы (1-999). Уникален. Сортировка списка по нему. Авто-присваивается max+1 при INSERT';

-- ─── PostgREST schema reload ─────────────────────────────────────────────
notify pgrst, 'reload schema';
