# Отчёт: связи событий с Telegram + orphan-сообщения

**Дата:** 2026-05-13 · **Окно анализа:** последние 14 дней (с 2026-04-28)

---

## 1. Что сделано

Применена миграция [`20260513000001_event_tg_link.sql`](../../supabase/migrations/20260513000001_event_tg_link.sql):
- `events.derived_source` — поле источника (`manual | tg | mail | bitrix | contract | protocol`)
- `event_tg_messages` — связь N:M между событием и TG-сообщением (с `confidence` и `link_kind`)
- `event_classifier_templates` — реестр типов событий для будущего автомата

Backfill SQL прошёл по корпусу 14 дней и связал найденные кандидаты:

| Метрика | Значение |
|---------|----------|
| Linked events | **55** |
| Linked tg messages | **12** уникальных |
| Total link rows | 60 |
| Events `derived_source='tg'` | 55 |
| Events `derived_source='manual'` за 14д | 13 (Мастерплан + общепроектные, для которых TG не источник) |

**Покрытие:** ~82% событий 14-дневного окна теперь имеют источник в Telegram.

---

## 2. Связки по объектам

| Объект | Linked events | Linked tg msgs | Avg conf |
|--------|--------------|----------------|----------|
| 006 Select | 26 | 5 | 50 |
| 003 Family 500 | 18 | 5 | 47 |
| 004 Health | 18 | 5 | 47 |
| 007 Бюро 82 | 16 | 10 | **68** ⭐ |
| 002 Family 800 | 10 | 3 | 44 |
| 008 Персонал | 9 | 3 | 45 |
| 000 Мастерплан | 1 | 2 | 40 |

Высокий avg_conf только у 007 (Бюро 82) — там много медиа с явным filename, легко матчится. У остальных много слабых (conf=40) связок-fallback — там события создаются по итогам обсуждения, конкретный «источник» неочевиден.

**Confidence levels:**
- `90`: media + filename + ±3ч — точный источник
- `75`: media + filename + ±12ч — высокая уверенность
- `65`: media без имени + ±12ч — средняя
- `50`: любое сообщение + ±6ч — слабая
- `40`: fallback — есть «что-то» в окне

---

## 3. Orphan media — 14 кандидатов на пропущенные события

Сообщения с медиа за 14 дней, **не привязанные** ни к одному событию. Эти стоит ревьюшнуть и решить — добавлять как event или это шум.

| Когда | Объект | От кого | Файл | Подпись |
|-------|--------|---------|------|---------|
| 11.05 12:10 | 007 | Ольга Анциферман | **Презентация_Отель 4_Бюро82.pdf** | «Во вложении материалы для презентации…» |
| 08.05 12:38 | 006 | Артем | webpage (forward) | Презентация проектов Бюро82 и MLA+ |
| 07.05 14:08 | 006 | Артём Ефимов MLA+ | webpage (forward) | Направляем презентацию с вариантами массинга |
| 05.05 08:13 | 007 | Артем | webpage (forward) | Рабочее собрание с Бюро 82 по результатам… |
| 04.05 17:19 | 004 | Артем | webpage (forward) | Оперативное собрание с Хэдс Групп… |
| 30.04 14:08 | 006 | Артём Ефимов MLA+ | webpage (forward) | Направляем альбом который демонстрировали… |
| 30.04 13:21 | 006 | Дмитрий | **Инструкция_по_дизайну_для_номеров_Club.pdf** | (без подписи) |
| 30.04 13:17 | 006 | Артем | photo_104257.jpg | (без подписи) |
| 30.04 13:05 | 006 | Артем | webpage (forward) | https://www.dropbox.com/scl/fo/… |
| 30.04 12:41 | 006 | Артем | webpage (forward) | Еженедельное рабочее собрание отель 4* Select |
| 30.04 12:41 | 004 | Артем | webpage (forward) | Собрание по замечаниям (предложениям) Масинг |
| 30.04 12:40 | 007 | Артем | webpage (forward) | Рабочее собрание с Бюро 82 по результатам… |
| 30.04 11:19 | 006 | Артем | **ФЗ на ЗПР 350 Club.pdf** | «Уважаемые коллеги @art_efimov…» |
| 28.04 14:10 | 004 | Артем | webpage (forward) | «Выслали полный пакет на почту» |

**Жирным** — кандидаты с явным filename, точно достойны event. Остальное — `webpage` forwards (приглашения на собрания), могут быть менее срочными.

---

## 4. Orphan text — 40 текстовых сообщений без события

Длинные текстовые сообщения (≥40 символов) без связи. Эти требуют **L2 LLM**, потому что событие выкристаллизовывается из обсуждения, а не из одного сообщения. См. полный список в результатах прогона.

Самый яркий пример — обсуждение в чате **004 Health** 07.05 06:00–12:17:
- Серия сообщений между Артемом, Искандером, Эннаном, Юрием, Кристиной про сроки этапа Масинг
- Результат обсуждения: «Принято. По отелю 800 и для персонала — у Вас график определился?»
- **Событие** «Согласованы сроки Масинга по 004/Health» — могло быть, но ручкой не создано

Этот тип событий L1 не поймает. Только L2 LLM с контекстом окна.

---

## 5. Что дальше — пошагово

### Этап 2 — `tg_classifier.py` (LLM)

Готова таблица `event_classifier_templates` с 11 типами:

**L1 (4 правила):**
- `doc_received` — получен документ от подрядчика
- `doc_sent` — направлен документ
- `material_link` — передана ссылка
- `photo_with_caption` — фото с подписью

**L2 (7 LLM-типов):**
- `meeting_scheduled` — назначено собрание / ВКС
- `meeting_held` — состоялось собрание
- `term_changed` — изменение сроков
- `decision_made` — принято решение
- `correction_received` — получены замечания
- `protocol_correction` — правка протокола
- `request_for_action` — поручение

Скрипт-классификатор будет:
1. Брать новые сообщения из `tg_messages` без связи в `event_tg_messages`
2. Применять L1-правила → создавать preliminary events с `derived_source='tg'`, `is_preliminary=true`, ссылкой через `event_tg_messages`
3. Для оставшихся текстовых окон (2-4ч группа) — LLM с промптом из `event_classifier_templates`
4. UI на странице `/events` показывает секцию «Из Telegram (preliminary)» с кнопками ✅ / ✏ / 🗑

### Этап 3 — расширение

Аналогично для email и Bitrix-чатов (когда подключим inbox-сторону), используя ту же таблицу `event_classifier_templates` и общий механизм `event_tg_messages` → `event_mail_messages` / `event_bitrix_messages`. Архитектура симметрична.

---

## 6. SQL-инструменты для ручной проверки

```bash
# Список связок с цитатой источника
docker exec supabase_db_zpr_code psql -U postgres -d postgres -c "
SELECT to_char(e.created_at, 'DD.MM HH24:MI') as e_when,
       left(e.title, 50) as event, l.confidence,
       to_char(m.msg_date, 'DD.MM HH24:MI') as m_when,
       m.sender_name, left(coalesce(m.media_file_name, m.text, ''), 60) as src
FROM event_tg_messages l
JOIN events e ON e.id = l.event_id
JOIN tg_messages m ON m.id = l.tg_message_id
ORDER BY l.confidence DESC, e.created_at DESC LIMIT 20;"

# Слабые связки (conf < 50) — кандидаты на пересмотр
docker exec supabase_db_zpr_code psql -U postgres -d postgres -c "
SELECT e.id, e.title, l.confidence
FROM event_tg_messages l JOIN events e ON e.id = l.event_id
WHERE l.confidence < 50 ORDER BY l.confidence;"

# Отвязать конкретную связь (если оказалась неправильной)
docker exec supabase_db_zpr_code psql -U postgres -d postgres -c "
DELETE FROM event_tg_messages WHERE event_id='<uuid>' AND tg_message_id='<uuid>';"
```
