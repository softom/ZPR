-- ====================================================================
-- Этап 1.1 — Комментарии для ветки «Договор»
-- COMMENT ON для legal_entities (новые поля), document_objects,
-- contract_clauses, documents (новые поля и переименование).
-- ====================================================================

-- ─── legal_entities (дополнения) ────────────────────────────────────────────

comment on column legal_entities.short_name       is 'Короткое имя для UI: «ХэдсГрупп», «МЛА+»';
comment on column legal_entities.entity_type     is 'Тип: legal (юр.лицо) | individual (ИП) | physical (физ.лицо)';
comment on column legal_entities.address_legal   is 'Юридический адрес (legacy address мигрирован сюда)';
comment on column legal_entities.address_postal  is 'Почтовый/фактический адрес (если отличается от юридического)';
comment on column legal_entities.signatory_basis is 'Основание полномочий подписанта: «Устав», «Доверенность №...», «Паспорт»';
comment on column legal_entities.bank_details    is 'JSONB: {account, bank_name, bik, corr_account, currency}';
comment on column legal_entities.email           is 'Контактный email';
comment on column legal_entities.phone           is 'Контактный телефон';
comment on column legal_entities.website         is 'Сайт юр.лица';
comment on column legal_entities.notes           is 'Свободные заметки оператора';
comment on column legal_entities.is_active       is 'true = активный, false = архив (soft delete). Запрет hard delete если есть активные договоры';

-- ─── document_objects ───────────────────────────────────────────────────────

comment on table  document_objects             is 'N:N связь договоров и объектов. Заменяет documents.object_codes JSONB';
comment on column document_objects.document_id is 'FK → documents.id (CASCADE при удалении договора)';
comment on column document_objects.object_code is 'FK → objects.code';

-- ─── contract_clauses ───────────────────────────────────────────────────────

comment on table  contract_clauses              is 'Пункты договора — единицы плана из текста договора. Не путать с events (БД событий проекта)';
comment on column contract_clauses.document_id  is 'FK → documents.id (CASCADE)';
comment on column contract_clauses.order_index  is 'Порядок реализации в договоре (1, 2, 3...). UNIQUE с document_id';
comment on column contract_clauses.clause_date  is 'Дата пункта (одна, срок исполнения). Диапазоны и уточнения — в note';
comment on column contract_clauses.description  is 'Описание пункта из договора';
comment on column contract_clauses.note         is 'Примечание оператора: вторая дата, оговорки, уточнения';
comment on column contract_clauses.source_page  is 'Страница в исходном PDF';
comment on column contract_clauses.source_quote is 'Точная цитата из договора';
comment on column contract_clauses.created_at   is 'Дата создания записи (auto)';

-- ─── documents (новые поля и переименование) ────────────────────────────────

comment on column documents.customer_entity_id   is 'FK → legal_entities.id — заказчик договора';
comment on column documents.contractor_entity_id is 'FK → legal_entities.id — подрядчик договора';
comment on column documents.parties_snapshot     is 'Снимок реквизитов сторон на момент подписания. Legacy формат: {customer: {name, inn, kpp, address, signatory}, contractor: {...}}. Источник истины — legal_entities через FK';
