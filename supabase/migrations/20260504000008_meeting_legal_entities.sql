-- ============================================================
-- meeting_legal_entities (N:N собрание ↔ юр.лицо)
-- ============================================================
-- Собрание обязательно с одним или несколькими юр.лицами. Это могут быть
-- подрядчики, заказчики, операторы, эксперты — любые организации из
-- legal_entities. Старое поле meetings.contractor_code остаётся как
-- внутреннее (для генерации tasks.code), но из UI убирается.

create table meeting_legal_entities (
    meeting_id      uuid not null references meetings(id) on delete cascade,
    legal_entity_id uuid not null references legal_entities(id) on delete restrict,
    role            text,                      -- 'customer'/'contractor'/'operator'/'consultant'/null
    seq             int,                       -- порядок отображения

    primary key (meeting_id, legal_entity_id)
);

comment on table  meeting_legal_entities is 'N:N связь собрания и юр.лиц-участников. Минимум одно юр.лицо обязательно.';
comment on column meeting_legal_entities.role is 'Роль организации на собрании: customer/contractor/operator/consultant. Опционально.';

create index meeting_legal_entities_meeting_idx on meeting_legal_entities (meeting_id);
create index meeting_legal_entities_entity_idx  on meeting_legal_entities (legal_entity_id);

notify pgrst, 'reload schema';
