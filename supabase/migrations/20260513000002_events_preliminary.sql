-- ============================================================================
-- events.is_preliminary + классификатор-источник правила
-- ============================================================================
-- Зачем:
--   is_preliminary=true   = создано автоматом (требует ручного подтверждения)
--   is_preliminary=false  = подтверждено / создано вручную
--   classifier_template_code — какой шаблон из event_classifier_templates сработал
-- ============================================================================

alter table events
    add column is_preliminary boolean not null default false,
    add column classifier_template_code text
        references event_classifier_templates(code) on delete set null;

create index events_preliminary_idx on events(is_preliminary) where is_preliminary = true;
create index events_classifier_template_idx on events(classifier_template_code)
    where classifier_template_code is not null;

insert into _applied_migrations (filename) values
    ('20260513000002_events_preliminary.sql')
on conflict do nothing;
