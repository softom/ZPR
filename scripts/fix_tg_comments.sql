comment on table  tg_chats is 'Реестр Telegram-чатов, попавших в whitelist. Заполняется telegram_listener.py при первом сообщении из чата + командой --sync-whitelist.';
comment on column tg_chats.chat_id is 'PK. Telegram chat_id (для групп/каналов отрицательный, для супергрупп с префиксом -100).';
comment on column tg_chats.title is 'Snapshot имени чата. Обновляется при каждом сообщении (Telethon отдаёт актуальный title в Event.chat).';
comment on column tg_chats.username is 'Snapshot @username чата (без @). NULL для приватных групп.';
comment on column tg_chats.kind is 'Тип чата: channel | group | supergroup | user. Определяется из telethon.tl.types.';
comment on column tg_chats.is_whitelisted is 'true = чат активно слушается. false = выключен (история остаётся, новых сообщений не пишем).';
comment on column tg_chats.handler is 'Обработчик сообщений. Сейчас единственный: raw (всё в tg_messages без классификации).';

comment on table  tg_messages is 'Сырой буфер Telegram-сообщений (handler=raw). LLM-классификация в documents/letters/tasks — отдельный процесс позднее.';
comment on column tg_messages.chat_id is 'FK → tg_chats.chat_id (CASCADE). Сообщения уничтожаются при удалении чата из реестра.';
comment on column tg_messages.message_id is 'Внутренний id сообщения в Telegram (уникален внутри чата). UNIQUE(chat_id, message_id) — защита от дублей при backfill.';
comment on column tg_messages.thread_id is 'Topic ID для форумов (supergroup с включёнными темами). NULL для обычных чатов.';
comment on column tg_messages.reply_to_msg_id is 'message_id сообщения, на которое отвечают. NULL если не ответ.';
comment on column tg_messages.sender_id is 'Telegram user_id (или channel_id для каналов от имени канала). NULL для системных сообщений.';
comment on column tg_messages.sender_username is 'Snapshot @username отправителя на момент сообщения.';
comment on column tg_messages.sender_name is 'Snapshot "Имя Фамилия" отправителя на момент сообщения.';
comment on column tg_messages.msg_date is 'Дата сообщения в Telegram (UTC).';
comment on column tg_messages.edit_date is 'Дата последней правки сообщения. NULL если не редактировалось.';
comment on column tg_messages.text is 'Текст сообщения или caption для медиа. NULL для медиа без подписи.';
comment on column tg_messages.has_media is 'true если у сообщения есть прикреплённый файл/медиа.';
comment on column tg_messages.media_kind is 'Тип медиа: photo | document | video | audio | voice | sticker | gif | poll | contact | geo | webpage | other.';
comment on column tg_messages.media_path is 'Относительный путь файла в STORAGE_DIR. Пример: TELEGRAM/2026/05/1234567890/42_контракт.pdf. NULL если медиа не скачивалось.';
comment on column tg_messages.media_file_name is 'Оригинальное имя файла (из Telethon Document.attributes), как было задано отправителем.';
comment on column tg_messages.raw_json is 'Сырое представление telethon.tl.types.Message в JSON (через .to_json()). Для отладки, forward-info, поля-расширения.';
comment on column tg_messages.ingested_at is 'Когда сообщение сохранили в БД (не равно msg_date — отличается при backfill).';

notify pgrst, 'reload schema';
