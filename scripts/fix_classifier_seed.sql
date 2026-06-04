-- Восстановление UTF-8 в seed event_classifier_templates после PowerShell-мигратора.

update event_classifier_templates set
    label = 'Получен документ от подрядчика',
    title_template = 'Получен документ «{filename}» от {sender}'
where code = 'doc_received';

update event_classifier_templates set
    label = 'Направлен документ подрядчику',
    title_template = 'Направлен документ «{filename}»'
where code = 'doc_sent';

update event_classifier_templates set
    label = 'Передана ссылка на материал',
    title_template = 'Передана ссылка: {caption}'
where code = 'material_link';

update event_classifier_templates set
    label = 'Фото с комментарием',
    title_template = 'Фото с комментарием: «{caption}»'
where code = 'photo_with_caption';

update event_classifier_templates set
    label = 'Назначено собрание / ВКС',
    title_template = 'Назначено собрание: {topic} ({when})'
where code = 'meeting_scheduled';

update event_classifier_templates set
    label = 'Состоялось собрание / ВКС',
    title_template = 'Состоялось собрание: {topic}'
where code = 'meeting_held';

update event_classifier_templates set
    label = 'Изменение договорных сроков',
    title_template = 'Изменение сроков: {description}'
where code = 'term_changed';

update event_classifier_templates set
    label = 'Принято решение',
    title_template = 'Принято решение: {description}'
where code = 'decision_made';

update event_classifier_templates set
    label = 'Получены замечания / правки',
    title_template = 'Получены замечания: {description}'
where code = 'correction_received';

update event_classifier_templates set
    label = 'Правка протокола',
    title_template = 'Правка протокола {meeting_date} от {party}'
where code = 'protocol_correction';

update event_classifier_templates set
    label = 'Поручение / запрос действия',
    title_template = 'Поручение: {description}'
where code = 'request_for_action';

-- Также комментарии таблиц
comment on table event_tg_messages is
    'Связь СОБЫТИЕ ↔ TG-сообщение (N:M). Одно событие может опираться на N сообщений (контекстная цепочка); одно сообщение может породить N событий (рассылка одного файла в N чатов).';
comment on column event_tg_messages.confidence is
    'Уверенность 0-100. 100 = подтверждено вручную. 60-99 = автомат-связка (классификатор). <50 = слабая привязка для контекста.';
comment on column event_tg_messages.link_kind is
    'Тип связи: source = главный источник; referenced = упомянуто/связано косвенно; context = окно обсуждения для понимания.';

comment on table event_classifier_templates is
    'Реестр типов событий, которые автомат-классификатор ищет в диалогах. layer=rule — детерминированные правила (L1), layer=llm — промпт для LLM-классификатора (L2).';
comment on column event_classifier_templates.code is
    'Машинный код типа. Используется в логах классификатора и в derived_event_type.';
comment on column event_classifier_templates.layer is
    'rule = детерминированные правила (быстро, без LLM); llm = LLM-промпт (для текстовых паттернов без явного триггера).';
comment on column event_classifier_templates.trigger_media_kinds is
    'Для layer=rule: массив media_kind, на которые срабатывает правило. Пример: {document,webpage}.';
comment on column event_classifier_templates.trigger_sender_role is
    'Для layer=rule: me = автор Артем Антипов; other = любой другой; any = неважно.';
comment on column event_classifier_templates.title_template is
    'Шаблон title для создаваемого события. Плейсхолдеры: {filename}, {sender}, {caption}, {date}, {description}, {topic}, {when}, {party}, {meeting_date}.';

comment on column events.derived_source is
    'Источник события: manual (создано вручную в UI), tg (Telegram-чат), mail (email), bitrix, contract (загружен договор), protocol (создано при approve протокола).';

notify pgrst, 'reload schema';
