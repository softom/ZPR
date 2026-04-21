-- ============================================================
-- Комментарии ко всем таблицам и полям схемы ЗПР
-- ============================================================

-- ── contractors ──────────────────────────────────────────────
comment on table  contractors            is 'Справочник подрядчиков проекта ЗПР';
comment on column contractors.id         is 'PK';
comment on column contractors.code       is 'Короткий код: ХГ, 8D, МЛА+';
comment on column contractors.full_name  is 'Полное наименование организации';
comment on column contractors.created_at is 'Дата создания записи (auto)';

-- ── objects ───────────────────────────────────────────────────
comment on table  objects              is 'Реестр строительных объектов проекта ЗПР';
comment on column objects.id           is 'PK';
comment on column objects.code         is 'Неизменяемый код объекта, пример: 006';
comment on column objects.current_name is 'Текущее официальное название объекта';
comment on column objects.contractor   is 'Код подрядчика (FK → contractors.code)';
comment on column objects.aliases      is 'JSONB-массив прежних имён и legacy-кодов: ["Хелс","04_HLT_260"]';
comment on column objects.created_at   is 'Дата создания записи (auto)';

-- ── folders ───────────────────────────────────────────────────
comment on table  folders              is 'Источник истины имён папок для объектов, подрядчиков и заказчиков';
comment on column folders.id           is 'PK';
comment on column folders.entity_type  is 'Тип сущности: object | contractor | customer';
comment on column folders.entity_code  is 'Код сущности: 006 / ХГ / ALEAN';
comment on column folders.storage      is 'Хранилище: хранилище | obsidian';
comment on column folders.folder_name  is 'Имя папки, пример: 006_ГОСТИНИЦА_400 или 006_ГОСТИНИЦА_400_(ХГ)';
comment on column folders.created_at   is 'Дата создания записи (auto)';

-- ── letters ───────────────────────────────────────────────────
comment on table  letters              is 'Реестр входящей и исходящей корреспонденции';
comment on column letters.id           is 'PK';
comment on column letters.date         is 'Дата документа (не дата загрузки)';
comment on column letters.direction    is 'Направление: incoming | outgoing';
comment on column letters.from_to      is 'Отправитель (incoming) или получатель (outgoing)';
comment on column letters.subject      is 'Тема письма (необязательно)';
comment on column letters.method       is 'Метод получения/отправки: Электронная_почта | ЭДО | Курьер | Скан | Факс | Лично | Инициализация';
comment on column letters.folder_path  is 'Относительный путь от корня Хранилища: ВХОДЯЩИЕ\2026_04_15_ХГ_ФЗ__Email';
comment on column letters.created_at   is 'Дата создания записи (auto)';

-- ── documents ─────────────────────────────────────────────────
comment on table  documents              is 'Реестр документов. Один документ может принадлежать нескольким объектам';
comment on column documents.id           is 'PK';
comment on column documents.letter_id    is 'FK → letters.id (письмо-источник, SET NULL при удалении письма)';
comment on column documents.object_codes is 'JSONB-массив кодов объектов: ["006","012"]';
comment on column documents.type         is 'Тип документа: ДОГОВОРА | ФЗ | ТЗ | МАТЕРИАЛЫ | ИРД | ТУ | ГРАФИКИ | СТАНДАРТЫ';
comment on column documents.title        is 'Название документа, пример: Договор ХГ-2026-003';
comment on column documents.version      is 'Версия: v1, v2, ДС1 …';
comment on column documents.folder_path  is 'Относительный путь от корня Хранилища: ДОГОВОРА\2026_01_23_..._v1__ЭДО';
comment on column documents.indexed_at   is 'Когда текст документа проиндексирован в pgvector';
comment on column documents.created_at   is 'Дата создания записи (auto)';

-- ── contract_milestones ───────────────────────────────────────
comment on table  contract_milestones                is 'Плановые этапы и сроки из договоров и дополнительных соглашений';
comment on column contract_milestones.id             is 'PK';
comment on column contract_milestones.document_id    is 'FK → documents.id (CASCADE DELETE)';
comment on column contract_milestones.object_code    is 'Код объекта, к которому относится этап';
comment on column contract_milestones.milestone_name is 'Название этапа, пример: Форэскиз';
comment on column contract_milestones.due_date       is 'Плановая дата завершения этапа';
comment on column contract_milestones.responsible    is 'Ответственная сторона (подрядчик или заказчик)';
comment on column contract_milestones.condition      is 'Условие, если дата условная: "после согласования ТЗ"';
comment on column contract_milestones.source         is 'Источник данных: ДС-1 | Приложение №3 | Раздел 4';
comment on column contract_milestones.created_at     is 'Дата создания записи (auto)';
