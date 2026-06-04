-- ============================================================
-- ZPR — masterplan_object_metrics (версионируемые значения метрик)
-- ============================================================
-- Все значения колонок 3-47 PDF ТЭП хранятся здесь, нормализованные
-- по справочнику `masterplan_metric_codes`. Версионирование через
-- (source, valid_from, valid_to).
--
-- При появлении новых данных (ТУ, проектные расчёты, факт):
-- INSERT новой записи → триггер автоматически закрывает старую
-- актуальную (с тем же object_id + metric_code + source).
--
-- См. WIKI 33_Сущность_Объект_Мастерплана.md
-- ============================================================

create table masterplan_object_metrics (
  id                   uuid primary key default gen_random_uuid(),
  masterplan_object_id uuid not null references masterplan_objects(id) on delete cascade,
  metric_code          text not null references masterplan_metric_codes(code),

  -- Значение: число (для большинства) или текст (для категорий, типа 'II')
  value_num            numeric,
  value_text           text,
  unit                 text,                              -- переопределяет default_unit при необходимости

  -- Источник версии
  source               text not null,                     -- 'ppt' | 'calc' | 'tu' | 'project' | 'fact'
  source_document_id   uuid references documents(id),

  -- Период валидности
  valid_from           date not null default current_date,
  valid_to             date,                              -- NULL = актуальная

  note                 text,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),

  check (value_num is not null or value_text is not null),
  check (valid_to is null or valid_to >= valid_from)
);

create index mom_obj_idx     on masterplan_object_metrics(masterplan_object_id);
create index mom_code_idx    on masterplan_object_metrics(metric_code);
create index mom_source_idx  on masterplan_object_metrics(source);
create index mom_current_idx on masterplan_object_metrics(masterplan_object_id, metric_code, source) where valid_to is null;

comment on table masterplan_object_metrics is
  'Версионируемые значения метрик (ТЭП + нагрузки) объекта мастерплана. Одна метрика может иметь несколько актуальных версий с разными source: ppt + calc + tu (например).';
comment on column masterplan_object_metrics.source is
  'Источник значения: ppt (ППТ — первичный), calc (расчётный из той же таблицы), tu (по ТУ), project (проектный), fact (фактический).';
comment on column masterplan_object_metrics.valid_to is
  'NULL = актуальная. При INSERT новой версии того же source триггер закрывает предыдущую.';

-- ============================================================
-- Триггер: закрытие старых версий при INSERT новой
-- ============================================================
-- Только для записей с одним и тем же (masterplan_object_id, metric_code, source).
-- Защита от закрытия записей одного batch-импорта: valid_from < new.valid_from.
create or replace function masterplan_object_metrics_close_old() returns trigger
language plpgsql as $$
begin
    if new.valid_to is null then
        update masterplan_object_metrics
           set valid_to = new.valid_from,
               updated_at = now()
         where masterplan_object_id = new.masterplan_object_id
           and metric_code = new.metric_code
           and source = new.source
           and id <> new.id
           and valid_to is null
           and valid_from < new.valid_from;
    end if;
    return new;
end$$;

create trigger tr_mom_close_old
    after insert on masterplan_object_metrics
    for each row execute function masterplan_object_metrics_close_old();

comment on function masterplan_object_metrics_close_old is
  'При INSERT новой актуальной (valid_to IS NULL) метрики — закрывает предыдущие того же (object, metric, source) с valid_from < new.valid_from. Защищает от закрытия записей одного batch-импорта.';
