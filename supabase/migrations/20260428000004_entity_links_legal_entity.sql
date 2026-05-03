-- ====================================================================
-- Добавить 'legal_entity' в допустимые типы entity_links
-- ====================================================================

alter table entity_links drop constraint entity_links_from_type_check;
alter table entity_links drop constraint entity_links_to_type_check;

alter table entity_links add constraint entity_links_from_type_check
    check (from_type in (
        'event','document','letter','object','milestone',
        'contractor','meeting','task','legal_entity'
    ));

alter table entity_links add constraint entity_links_to_type_check
    check (to_type in (
        'event','document','letter','object','milestone',
        'contractor','meeting','task','legal_entity'
    ));

-- helper: все события, связанные с юр.лицом
create or replace function legal_entity_events(p_entity_id uuid)
returns table(event_id uuid) language sql stable as $$
    select from_id::uuid
      from entity_links
     where from_type = 'event'
       and to_type   = 'legal_entity'
       and to_id     = p_entity_id::text;
$$;

notify pgrst, 'reload schema';
