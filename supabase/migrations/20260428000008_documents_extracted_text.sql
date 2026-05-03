-- ====================================================================
-- documents.extracted_text — полный текст договора для повторного анализа
-- ====================================================================
-- Сохраняется при первой загрузке (POST /api/contracts/v2/save).
-- Используется кнопкой «🔄 Переразобрать пункты» (POST /api/contracts/v2/[id]/reparse) —
-- LLM анализирует тот же текст заново без необходимости перезагружать PDF.
--
-- Содержит маркеры [PAGE N] (вставлены клиентским pdfjs при первичном чтении).

alter table documents
  add column if not exists extracted_text text;

comment on column documents.extracted_text
  is 'Полный текст договора с маркерами [PAGE N]. Для повторного анализа без перезагрузки PDF.';

notify pgrst, 'reload schema';
