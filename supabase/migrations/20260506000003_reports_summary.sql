-- Общая сводка отчёта: текст «по проекту целиком», который LLM формирует
-- на основе всех секций (object_reports). Хранится в формате Markdown.

alter table reports add column summary_md text;

comment on column reports.summary_md is
    'Общая сводка по проекту целиком (LLM на основе всех object_reports). NULL = не сформирована.';

notify pgrst, 'reload schema';
