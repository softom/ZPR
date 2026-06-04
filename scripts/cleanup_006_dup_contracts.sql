-- =================================================================
-- Чистка 4 тестовых дублей договора № 2604-01 для объекта 006_ГОСТИНИЦА_350
-- =================================================================
-- Победитель (НЕ ТРОГАТЬ):
--   5316c232-4387-4ac9-9c23-b2bcd0866474  (doc_number='2604-01', 12 chunks, 22 этапа)
--
-- Тесты на удаление:
--   0d6ee545-7ce6-4a45-b5e1-8445ca54a18e  (без doc_number, 0 chunks, 9 этапов)
--   9eb078fb-c6e6-46e3-8dec-c432fd4406ca  (без doc_number, 0 chunks, 4 этапа)
--   6b4554ba-aea7-4caf-85be-195cc63967fd  (без doc_number, 0 chunks, 3 этапа)
--   89b42d83-b30b-46b0-8ce4-fe14642be40f  (без doc_number, 0 chunks, 4 этапа)
--
-- Стратегия: сначала DROP связанных calendar_entries (через FK не идёт — связь через
-- entity_links), затем DROP entity_links, затем DROP document_objects, затем DROP документ.
-- Все этапы дублей будут потеряны — это безопасно, т.к. они УЖЕ есть у победителя
-- (видно по сравнению title/date_end — 22 у победителя vs 20 у дублей суммарно).
-- =================================================================

BEGIN;

-- 1) Список ID для удобства
WITH dup_docs AS (
    SELECT id FROM documents
    WHERE id IN (
        '0d6ee545-7ce6-4a45-b5e1-8445ca54a18e',
        '9eb078fb-c6e6-46e3-8dec-c432fd4406ca',
        '6b4554ba-aea7-4caf-85be-195cc63967fd',
        '89b42d83-b30b-46b0-8ce4-fe14642be40f'
    )
),
-- 2) calendar_entries, ссылающиеся ТОЛЬКО на эти дубль-документы
dup_cal_ids AS (
    SELECT DISTINCT ce.id
    FROM calendar_entries ce
    JOIN entity_links el ON el.from_type='calendar_entry' AND el.from_id=ce.id::text
    WHERE el.to_type='document' AND el.to_id IN (SELECT id::text FROM dup_docs)
      -- защита: НЕ удалять calendar_entry если он также ссылается на победителя
      AND NOT EXISTS (
          SELECT 1 FROM entity_links el2
          WHERE el2.from_type='calendar_entry'
            AND el2.from_id=ce.id::text
            AND el2.to_type='document'
            AND el2.to_id='5316c232-4387-4ac9-9c23-b2bcd0866474'
      )
)

-- DEBUG SELECT — посмотри что планируется удалить ПЕРЕД commit
SELECT 'CAL ENTRIES TO DELETE' as section, count(*) FROM dup_cal_ids
UNION ALL
SELECT 'ENTITY_LINKS TO DELETE',
       (SELECT count(*) FROM entity_links
        WHERE (from_type='calendar_entry' AND from_id IN (SELECT id::text FROM dup_cal_ids))
           OR (to_type='document' AND to_id IN (SELECT id::text FROM dup_docs))
           OR (from_type='document' AND from_id IN (SELECT id::text FROM dup_docs)))
UNION ALL
SELECT 'DOCUMENT_OBJECTS TO DELETE',
       (SELECT count(*) FROM document_objects WHERE document_id IN (SELECT id FROM dup_docs))
UNION ALL
SELECT 'DOCUMENTS TO DELETE', (SELECT count(*) FROM dup_docs);

ROLLBACK;

-- =================================================================
-- Если SELECT выше показал ожидаемые числа (CAL ENTRIES ≤ 20,
-- DOCS = 4) — раскомментируй блок ниже и выполни как отдельный батч:
-- =================================================================

/*
BEGIN;

DELETE FROM entity_links
WHERE from_type='calendar_entry'
  AND from_id IN (
    SELECT ce.id::text
    FROM calendar_entries ce
    JOIN entity_links el ON el.from_type='calendar_entry' AND el.from_id=ce.id::text
    WHERE el.to_type='document' AND el.to_id IN (
        '0d6ee545-7ce6-4a45-b5e1-8445ca54a18e',
        '9eb078fb-c6e6-46e3-8dec-c432fd4406ca',
        '6b4554ba-aea7-4caf-85be-195cc63967fd',
        '89b42d83-b30b-46b0-8ce4-fe14642be40f'
    )
    AND NOT EXISTS (
        SELECT 1 FROM entity_links el2
        WHERE el2.from_type='calendar_entry' AND el2.from_id=ce.id::text
          AND el2.to_type='document' AND el2.to_id='5316c232-4387-4ac9-9c23-b2bcd0866474'
    )
  );

DELETE FROM calendar_entries
WHERE id IN (
    SELECT DISTINCT ce.id
    FROM calendar_entries ce
    LEFT JOIN entity_links el ON el.from_type='calendar_entry' AND el.from_id=ce.id::text
    WHERE el.id IS NULL  -- осиротевшие после DELETE entity_links
);

DELETE FROM entity_links
WHERE (to_type='document' AND to_id IN (
        '0d6ee545-7ce6-4a45-b5e1-8445ca54a18e',
        '9eb078fb-c6e6-46e3-8dec-c432fd4406ca',
        '6b4554ba-aea7-4caf-85be-195cc63967fd',
        '89b42d83-b30b-46b0-8ce4-fe14642be40f'
    ))
   OR (from_type='document' AND from_id IN (
        '0d6ee545-7ce6-4a45-b5e1-8445ca54a18e',
        '9eb078fb-c6e6-46e3-8dec-c432fd4406ca',
        '6b4554ba-aea7-4caf-85be-195cc63967fd',
        '89b42d83-b30b-46b0-8ce4-fe14642be40f'
    ));

DELETE FROM document_objects
WHERE document_id IN (
    '0d6ee545-7ce6-4a45-b5e1-8445ca54a18e',
    '9eb078fb-c6e6-46e3-8dec-c432fd4406ca',
    '6b4554ba-aea7-4caf-85be-195cc63967fd',
    '89b42d83-b30b-46b0-8ce4-fe14642be40f'
);

DELETE FROM documents
WHERE id IN (
    '0d6ee545-7ce6-4a45-b5e1-8445ca54a18e',
    '9eb078fb-c6e6-46e3-8dec-c432fd4406ca',
    '6b4554ba-aea7-4caf-85be-195cc63967fd',
    '89b42d83-b30b-46b0-8ce4-fe14642be40f'
);

COMMIT;
*/
