-- ============================================================
-- meetings.transcription_resolved_path — путь к распознанной транскрипции
-- ============================================================
-- После /process парсер применяет speaker_map к CSV и сохраняет результат
-- (с реальными именами вместо «Speaker N») рядом с исходником как
-- «<имя_исходника>.resolved.txt». Этот путь — снимок текста, который
-- реально пошёл в LLM, удобно для диагностики и повторных запусков.

alter table meetings
    add column if not exists transcription_resolved_path text;

comment on column meetings.transcription_resolved_path is
    'Относительный путь от STORAGE_DIR к файлу распознанной транскрипции (с применённым speaker_map). Записывается /process после каждого парсинга.';

notify pgrst, 'reload schema';
